import { randomBytes } from "crypto";
import { type AdapterUser } from "next-auth/adapters";
import { NextRequest, NextResponse } from "next/server";

import { env } from "~/env";
import {
  authOptions,
  canRegisterSelfHostedUser,
  isSelfHostedEmailAllowed,
} from "~/server/auth";
import { verifyCloudflareAccessJwt } from "~/server/cloudflare-access";
import { db } from "~/server/db";

const SESSION_DURATION_SECONDS = 24 * 60 * 60;
const SESSION_COOKIE = "__Secure-next-auth.session-token";

function safeCallbackPath(value: string | null) {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return "/dashboard";
  }

  return value;
}

export async function GET(request: NextRequest) {
  if (
    !env.CLOUDFLARE_ACCESS_TEAM_DOMAIN ||
    !env.CLOUDFLARE_ACCESS_AUD ||
    env.NEXT_PUBLIC_IS_CLOUD
  ) {
    return NextResponse.json(
      { error: "Cloudflare Access authentication is not configured" },
      { status: 404 },
    );
  }

  const assertion = request.headers.get("cf-access-jwt-assertion");
  if (!assertion) {
    return NextResponse.json(
      { error: "Cloudflare Access assertion is missing" },
      { status: 401 },
    );
  }

  let email: string;
  try {
    ({ email } = await verifyCloudflareAccessJwt(assertion, {
      teamDomain: env.CLOUDFLARE_ACCESS_TEAM_DOMAIN,
      audience: env.CLOUDFLARE_ACCESS_AUD,
    }));
  } catch {
    return NextResponse.json(
      { error: "Cloudflare Access assertion is invalid" },
      { status: 401 },
    );
  }

  if (!isSelfHostedEmailAllowed(email)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  let user = await db.user.findUnique({ where: { email } });

  if (!user) {
    if (!(await canRegisterSelfHostedUser(email))) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const createUser = authOptions.adapter?.createUser;
    if (!createUser) {
      return NextResponse.json(
        { error: "Authentication adapter is unavailable" },
        { status: 500 },
      );
    }

    await createUser({
      id: "",
      name: email.split("@")[0] ?? email,
      email,
      emailVerified: new Date(),
      image: null,
    } as AdapterUser);

    user = await db.user.findUnique({ where: { email } });
    if (user && !user.isBetaUser) {
      user = await db.user.update({
        where: { id: user.id },
        data: { isBetaUser: true },
      });
    }
  }

  if (!user) {
    return NextResponse.json(
      { error: "Unable to establish authenticated user" },
      { status: 500 },
    );
  }

  const sessionToken = randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_DURATION_SECONDS * 1000);

  await db.session.create({
    data: {
      expires,
      sessionToken,
      userId: user.id,
    },
  });

  const pendingInvite = await db.teamInvite.findFirst({
    where: { email },
    select: { id: true },
  });

  const callbackPath = pendingInvite
    ? `/join-team?inviteId=${encodeURIComponent(pendingInvite.id)}`
    : safeCallbackPath(request.nextUrl.searchParams.get("callbackUrl"));
  const response = NextResponse.redirect(
    new URL(callbackPath, env.NEXTAUTH_URL),
  );
  response.cookies.set(SESSION_COOKIE, sessionToken, {
    expires,
    httpOnly: true,
    maxAge: SESSION_DURATION_SECONDS,
    path: "/",
    sameSite: "lax",
    secure: true,
  });

  return response;
}
