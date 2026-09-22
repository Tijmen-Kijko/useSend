import NextAuth from "next-auth";

import { authOptions } from "~/server/auth";
import { env } from "~/env";
import { getRedis, redisKey } from "~/server/redis";
import { logger } from "~/server/logger/log";
import { consumeFixedWindowRateLimit } from "~/server/rate-limit";

const handler = NextAuth(authOptions);

export { handler as GET };

function getClientIp(req: Request): string | null {
  const h = req.headers;
  const direct =
    h.get("cf-connecting-ip") ??
    h.get("true-client-ip") ??
    h.get("x-forwarded-for") ??
    h.get("x-real-ip") ??
    h.get("x-client-ip") ??
    h.get("fastly-client-ip") ??
    h.get("x-cluster-client-ip") ??
    null;

  let ip = direct?.split(",")[0]?.trim() ?? "";

  if (!ip) {
    const fwd = h.get("forwarded");
    if (fwd) {
      const first = fwd.split(",")[0];
      const match = first?.match(/for=([^;]+)/i);
      if (match && match[1]) {
        const raw = match[1].trim().replace(/^"|"$/g, "");
        if (raw.startsWith("[")) {
          const end = raw.indexOf("]");
          ip = end !== -1 ? raw.slice(1, end) : raw;
        } else {
          const parts = raw.split(":");
          if (parts.length > 0 && parts[0]) {
            ip =
              parts.length === 2 && /^\d+(?:\.\d+){3}$/.test(parts[0])
                ? parts[0]
                : raw;
          }
        }
      }
    }
  }

  return ip || null;
}

export async function POST(req: Request, ctx: any) {
  if (env.AUTH_EMAIL_RATE_LIMIT > 0) {
    const url = new URL(req.url);
    if (url.pathname.endsWith("/signin/email")) {
      const ip = getClientIp(req);
      if (!ip) {
        logger.error("Auth email rate limit failed: missing client IP");
        return Response.json(
          {
            error: {
              code: "SERVICE_UNAVAILABLE",
              message: "Authentication rate limiter is unavailable",
            },
          },
          { status: 503 },
        );
      }

      try {
        const redis = getRedis();
        const rateLimit = await consumeFixedWindowRateLimit({
          redis,
          key: redisKey(`auth-rl:${ip}`),
          limit: env.AUTH_EMAIL_RATE_LIMIT,
          windowSeconds: 60,
        });

        if (!rateLimit.allowed) {
          logger.warn({ ip }, "Auth email rate limit exceeded");
          return Response.json(
            {
              error: {
                code: "RATE_LIMITED",
                message: "Too many requests",
              },
            },
            {
              status: 429,
              headers: {
                "Retry-After": String(rateLimit.retryAfterSeconds),
                "X-RateLimit-Limit": String(env.AUTH_EMAIL_RATE_LIMIT),
                "X-RateLimit-Remaining": String(rateLimit.remaining),
                "X-RateLimit-Reset": String(rateLimit.resetAtUnixSeconds),
              },
            },
          );
        }
      } catch (error) {
        logger.error({ err: error }, "Auth email rate limit failed");
        return Response.json(
          {
            error: {
              code: "SERVICE_UNAVAILABLE",
              message: "Authentication rate limiter is unavailable",
            },
          },
          { status: 503 },
        );
      }
    }
  }

  return handler(req, ctx);
}
