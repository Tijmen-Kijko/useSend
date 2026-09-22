import { OpenAPIHono } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { Context, Next } from "hono";
import { handleError } from "./api-error";
import { env } from "~/env";
import { getRedis, redisKey } from "~/server/redis";
import { getTeamFromToken } from "~/server/public-api/auth";
import { isSelfHosted } from "~/utils/common";
import { UnsendApiError } from "./api-error";
import { ApiPermission, Team } from "@prisma/client";
import { logger } from "../logger/log";
import { isApiKeyAuthorized } from "./api-key-authorization";
import { consumeFixedWindowRateLimit } from "~/server/rate-limit";

// Define AppEnv for Hono context
export type AppEnv = {
  Variables: {
    team: Team & {
      apiKeyId: number;
      apiKey: {
        domainId: number | null;
        permission: ApiPermission;
      };
    };
  };
};

export function getApp() {
  const app = new OpenAPIHono<AppEnv>().basePath("/api");

  app.onError(handleError);

  // Auth and Team Middleware (runs before rate limiter)
  app.use("*", async (c: Context<AppEnv>, next: Next) => {
    if (
      c.req.path.startsWith("/api/v1/doc") ||
      c.req.path.startsWith("/api/v1/ui") ||
      c.req.path === "/api/health"
    ) {
      return next();
    }

    try {
      const team = await getTeamFromToken(c as any);
      c.set("team", team);
    } catch (error) {
      if (error instanceof UnsendApiError) {
        throw error;
      }
      logger.error({ err: error }, "Error in getTeamFromToken middleware");
      throw new UnsendApiError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Authentication failed",
      });
    }
    await next();
  });

  // Authorization middleware. Protected public API routes are default-deny
  // until they are explicitly included in the permission matrix.
  app.use("*", async (c: Context<AppEnv>, next: Next) => {
    if (
      c.req.path.startsWith("/api/v1/doc") ||
      c.req.path.startsWith("/api/v1/ui") ||
      c.req.path === "/api/health"
    ) {
      return next();
    }

    const team = c.var.team;
    if (
      !team ||
      !isApiKeyAuthorized({
        permission: team.apiKey.permission,
        method: c.req.method,
        path: c.req.path,
      })
    ) {
      throw new UnsendApiError({
        code: "FORBIDDEN",
        message: "API key does not have permission for this endpoint",
      });
    }

    await next();
  });

  // Fixed-window API rate limiter. In self-hosted mode, the limit comes
  // from API_RATE_LIMIT; cloud mode keeps the team-specific limit. The key is
  // per API credential so multiple projects in one self-hosted Team do not
  // consume each other's quota.
  const RATE_LIMIT_WINDOW_SECONDS = 1;

  app.use("*", async (c: Context<AppEnv>, next: Next) => {
    if (
      !c.var.team ||
      c.req.path.startsWith("/api/v1/doc") ||
      c.req.path.startsWith("/api/v1/ui") ||
      c.req.path === "/api/health"
    ) {
      return next();
    }

    const team = c.var.team;
    const limit = isSelfHosted()
      ? env.API_RATE_LIMIT
      : (team.apiRateLimit ?? env.API_RATE_LIMIT);
    const key = redisKey(`rl:api-key:${team.apiKeyId}`);
    const redis = getRedis();

    let rateLimit;
    try {
      rateLimit = await consumeFixedWindowRateLimit({
        redis,
        key,
        limit,
        windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
      });
    } catch (error) {
      logger.error(
        {
          err: error,
          teamId: team.id,
          apiKeyId: team.apiKeyId,
        },
        "API rate limiter unavailable",
      );
      throw new UnsendApiError({
        code: "SERVICE_UNAVAILABLE",
        message: "API rate limiter is temporarily unavailable",
      });
    }

    c.res.headers.set("X-RateLimit-Limit", String(limit));
    c.res.headers.set("X-RateLimit-Remaining", String(rateLimit.remaining));
    c.res.headers.set(
      "X-RateLimit-Reset",
      String(rateLimit.resetAtUnixSeconds),
    );

    if (!rateLimit.allowed) {
      c.res.headers.set(
        "Retry-After",
        String(rateLimit.retryAfterSeconds),
      );
      logger.warn(
        {
          teamId: team.id,
          apiKeyId: team.apiKeyId,
          method: c.req.method,
          path: c.req.path,
          limit,
          currentRequests: rateLimit.current,
          retryAfterSeconds: rateLimit.retryAfterSeconds,
        },
        "API rate limit exceeded",
      );
      throw new UnsendApiError({
        code: "RATE_LIMITED",
        message: `Rate limit exceeded. Try again in ${rateLimit.retryAfterSeconds} seconds.`,
      });
    }

    await next();
  });

  // The OpenAPI documentation will be available at /doc
  app.doc("/v1/doc", () => ({
    openapi: "3.0.0",
    info: {
      version: "1.0.0",
      title: "useSend API",
    },
    servers: [{ url: `${env.NEXTAUTH_URL}/api` }],
  }));

  app.openAPIRegistry.registerComponent("securitySchemes", "Bearer", {
    type: "http",
    scheme: "bearer",
  });

  app.get("/v1/ui", swaggerUI({ url: "/api/v1/doc" }));

  return app;
}

export type PublicAPIApp = OpenAPIHono<AppEnv>;
