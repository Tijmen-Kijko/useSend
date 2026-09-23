import { redirect } from "next/navigation";
import { getServerAuthSession } from "~/server/auth";
import LoginPage from "../login/login-page";
import { getProviders } from "next-auth/react";
import { env } from "~/env";

export default async function Login() {
  const session = await getServerAuthSession();

  if (session) {
    redirect("/dashboard");
  }

  if (
    !env.NEXT_PUBLIC_IS_CLOUD &&
    env.CLOUDFLARE_ACCESS_TEAM_DOMAIN &&
    env.CLOUDFLARE_ACCESS_AUD
  ) {
    redirect("/api/auth/cloudflare-access?callbackUrl=/dashboard");
  }

  const providers = await getProviders();

  return <LoginPage providers={Object.values(providers ?? {})} isSignup />;
}
