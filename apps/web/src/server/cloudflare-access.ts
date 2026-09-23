import "server-only";

import { createPublicKey, createVerify, type JsonWebKey } from "crypto";

type AccessJwtHeader = {
  alg?: string;
  kid?: string;
};

type AccessJwtClaims = {
  aud?: string | string[];
  email?: string;
  exp?: number;
  iss?: string;
  nbf?: number;
};

type AccessJwk = JsonWebKey & {
  alg?: string;
  kid?: string;
  use?: string;
};

type CachedJwks = {
  expiresAt: number;
  keys: AccessJwk[];
  origin: string;
};

let cachedJwks: CachedJwks | null = null;

const JWKS_CACHE_MS = 5 * 60 * 1000;
const CLOCK_SKEW_SECONDS = 60;

function decodeJsonPart<T>(value: string): T {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
  } catch {
    throw new Error("Invalid Cloudflare Access JWT encoding");
  }
}

function normalizeTeamOrigin(teamDomain: string) {
  const candidate = teamDomain.includes("://")
    ? teamDomain
    : `https://${teamDomain}`;
  const url = new URL(candidate);

  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("Invalid Cloudflare Access team domain");
  }

  return url.origin;
}

async function getJwks(origin: string): Promise<AccessJwk[]> {
  const now = Date.now();
  if (
    cachedJwks &&
    cachedJwks.origin === origin &&
    cachedJwks.expiresAt > now
  ) {
    return cachedJwks.keys;
  }

  const response = await fetch(`${origin}/cdn-cgi/access/certs`, {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error("Unable to load Cloudflare Access signing keys");
  }

  const body = (await response.json()) as { keys?: AccessJwk[] };
  const keys = Array.isArray(body.keys) ? body.keys : [];

  if (keys.length === 0) {
    throw new Error("Cloudflare Access signing keys are missing");
  }

  cachedJwks = {
    origin,
    keys,
    expiresAt: now + JWKS_CACHE_MS,
  };

  return keys;
}

export async function verifyCloudflareAccessJwt(
  token: string,
  {
    teamDomain,
    audience,
    nowSeconds = Math.floor(Date.now() / 1000),
  }: {
    teamDomain: string;
    audience: string;
    nowSeconds?: number;
  },
) {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid Cloudflare Access JWT");
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  if (!encodedHeader || !encodedPayload || !encodedSignature) {
    throw new Error("Invalid Cloudflare Access JWT");
  }

  const header = decodeJsonPart<AccessJwtHeader>(encodedHeader);
  const claims = decodeJsonPart<AccessJwtClaims>(encodedPayload);

  if (header.alg !== "RS256" || !header.kid) {
    throw new Error("Unsupported Cloudflare Access JWT");
  }

  const origin = normalizeTeamOrigin(teamDomain);
  const issuer = String(claims.iss ?? "").replace(/\/$/, "");
  if (issuer !== origin) {
    throw new Error("Cloudflare Access JWT issuer mismatch");
  }

  const audiences = Array.isArray(claims.aud)
    ? claims.aud
    : claims.aud
      ? [claims.aud]
      : [];
  if (!audiences.includes(audience)) {
    throw new Error("Cloudflare Access JWT audience mismatch");
  }

  if (
    typeof claims.exp !== "number" ||
    claims.exp < nowSeconds - CLOCK_SKEW_SECONDS
  ) {
    throw new Error("Cloudflare Access JWT is expired");
  }

  if (
    typeof claims.nbf === "number" &&
    claims.nbf > nowSeconds + CLOCK_SKEW_SECONDS
  ) {
    throw new Error("Cloudflare Access JWT is not active yet");
  }

  const email = claims.email?.trim().toLowerCase();
  if (!email) {
    throw new Error("Cloudflare Access JWT email is missing");
  }

  const keys = await getJwks(origin);
  const jwk = keys.find(
    (candidate) =>
      candidate.kid === header.kid &&
      candidate.kty === "RSA" &&
      candidate.alg === "RS256",
  );

  if (!jwk) {
    throw new Error("Cloudflare Access signing key is unknown");
  }

  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${encodedHeader}.${encodedPayload}`);
  verifier.end();

  const valid = verifier.verify(
    createPublicKey({ key: jwk as unknown as JsonWebKey, format: "jwk" }),
    Buffer.from(encodedSignature, "base64url"),
  );

  if (!valid) {
    throw new Error("Cloudflare Access JWT signature is invalid");
  }

  return { email };
}
