import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnsendApiError } from "~/server/public-api/api-error";

const { mockGetTeamFromToken, mockRedis } = vi.hoisted(() => ({
  mockGetTeamFromToken: vi.fn(),
  mockRedis: {
    incr: vi.fn(),
    expire: vi.fn(),
    ttl: vi.fn(),
  },
}));

vi.mock("~/server/public-api/auth", () => ({
  getTeamFromToken: mockGetTeamFromToken,
}));

vi.mock("~/server/redis", () => ({
  getRedis: () => mockRedis,
  redisKey: (key: string) => key,
}));

vi.mock("~/utils/common", () => ({
  isSelfHosted: () => false,
}));

import { getApp } from "~/server/public-api/hono";

function fullTeam() {
  return {
    id: 1,
    apiRateLimit: 2,
    apiKeyId: 11,
    apiKey: { domainId: null, permission: "FULL" },
  };
}

function sendingTeam() {
  return {
    id: 1,
    apiRateLimit: 2,
    apiKeyId: 11,
    apiKey: { domainId: null, permission: "SENDING" },
  };
}

describe("public API Hono middleware", () => {
  beforeEach(() => {
    mockGetTeamFromToken.mockReset();
    mockRedis.incr.mockReset();
    mockRedis.expire.mockReset();
    mockRedis.ttl.mockReset();
  });

  it("applies auth and rate limit headers", async () => {
    mockGetTeamFromToken.mockResolvedValue(fullTeam());
    mockRedis.incr.mockResolvedValue(1);
    mockRedis.expire.mockResolvedValue(1);
    mockRedis.ttl.mockResolvedValue(1);

    const app = getApp();
    app.get("/v1/emails", (c) => c.json({ ok: true }));

    const response = await app.request("http://localhost/api/v1/emails", {
      headers: {
        Authorization: "Bearer test-key",
      },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("X-RateLimit-Limit")).toBe("2");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("1");
  });

  it("returns 429 when limit is exceeded", async () => {
    mockGetTeamFromToken.mockResolvedValue(fullTeam());
    mockRedis.incr.mockResolvedValue(3);
    mockRedis.ttl.mockResolvedValue(1);

    const app = getApp();
    app.get("/v1/emails", (c) => c.json({ ok: true }));

    const response = await app.request("http://localhost/api/v1/emails", {
      headers: {
        Authorization: "Bearer test-key",
      },
    });

    expect(response.status).toBe(429);
    const body = await response.json();
    expect(body).toMatchObject({
      error: {
        code: "RATE_LIMITED",
      },
    });
  });

  it("returns auth error from middleware", async () => {
    mockGetTeamFromToken.mockRejectedValue(
      new UnsendApiError({
        code: "UNAUTHORIZED",
        message: "No Authorization header provided",
      }),
    );

    const app = getApp();
    app.get("/v1/emails", (c) => c.json({ ok: true }));

    const response = await app.request("http://localhost/api/v1/emails");

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body).toMatchObject({
      error: {
        code: "UNAUTHORIZED",
      },
    });
  });

  it("allows a SENDING key to use email lifecycle endpoints", async () => {
    mockGetTeamFromToken.mockResolvedValue(sendingTeam());
    mockRedis.incr.mockResolvedValue(1);
    mockRedis.expire.mockResolvedValue(1);
    mockRedis.ttl.mockResolvedValue(1);

    const app = getApp();
    app.post("/v1/emails", (c) => c.json({ ok: true }));

    const response = await app.request("http://localhost/api/v1/emails", {
      method: "POST",
      headers: {
        Authorization: "Bearer sending-key",
      },
    });

    expect(response.status).toBe(200);
  });

  it("denies a SENDING key access to management endpoints", async () => {
    mockGetTeamFromToken.mockResolvedValue(sendingTeam());

    const app = getApp();
    app.get("/v1/domains", (c) => c.json({ ok: true }));

    const response = await app.request("http://localhost/api/v1/domains", {
      headers: {
        Authorization: "Bearer sending-key",
      },
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "FORBIDDEN",
      },
    });
    expect(mockRedis.incr).not.toHaveBeenCalled();
  });

  it("default-denies an unmapped endpoint even for a FULL key", async () => {
    mockGetTeamFromToken.mockResolvedValue(fullTeam());

    const app = getApp();
    app.get("/v1/future-admin-endpoint", (c) => c.json({ ok: true }));

    const response = await app.request(
      "http://localhost/api/v1/future-admin-endpoint",
      {
        headers: {
          Authorization: "Bearer full-key",
        },
      },
    );

    expect(response.status).toBe(403);
  });
});
