import { beforeEach, describe, expect, it, vi } from "vitest";
import { UnsendApiError } from "~/server/public-api/api-error";

const { state, mockGetTeamFromToken, mockRedis } = vi.hoisted(() => ({
  state: {
    selfHosted: false,
  },
  mockGetTeamFromToken: vi.fn(),
  mockRedis: {
    eval: vi.fn(),
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
  isSelfHosted: () => state.selfHosted,
}));

import { getApp } from "~/server/public-api/hono";

function fullTeam(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    apiRateLimit: 2,
    apiKeyId: 11,
    apiKey: { domainId: null, permission: "FULL" },
    ...overrides,
  };
}

function sendingTeam(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    apiRateLimit: 2,
    apiKeyId: 11,
    apiKey: { domainId: null, permission: "SENDING" },
    ...overrides,
  };
}

describe("public API Hono middleware", () => {
  beforeEach(() => {
    state.selfHosted = false;
    mockGetTeamFromToken.mockReset();
    mockRedis.eval.mockReset();
  });

  it("applies auth and rate limit headers", async () => {
    mockGetTeamFromToken.mockResolvedValue(fullTeam());
    mockRedis.eval.mockResolvedValue([1, 1]);

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
    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "rl:api-key:11",
      "1",
    );
  });

  it("returns 429 and Retry-After when limit is exceeded", async () => {
    mockGetTeamFromToken.mockResolvedValue(fullTeam());
    mockRedis.eval.mockResolvedValue([3, 1]);

    const app = getApp();
    app.get("/v1/emails", (c) => c.json({ ok: true }));

    const response = await app.request("http://localhost/api/v1/emails", {
      headers: {
        Authorization: "Bearer test-key",
      },
    });

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("1");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
    const body = await response.json();
    expect(body).toMatchObject({
      error: {
        code: "RATE_LIMITED",
      },
    });
  });

  it("enforces the configured API limit in self-hosted mode", async () => {
    state.selfHosted = true;
    mockGetTeamFromToken.mockResolvedValue(
      fullTeam({
        apiRateLimit: 999,
      }),
    );
    mockRedis.eval.mockResolvedValue([2, 1]);

    const app = getApp();
    app.get("/v1/emails", (c) => c.json({ ok: true }));

    const response = await app.request("http://localhost/api/v1/emails", {
      headers: {
        Authorization: "Bearer selfhost-key",
      },
    });

    expect(response.status).toBe(200);
    // setup-env configures API_RATE_LIMIT=2; the team value above must not win.
    expect(response.headers.get("X-RateLimit-Limit")).toBe("2");
  });

  it("keys rate limits by API key so projects in one Team are isolated", async () => {
    mockRedis.eval.mockResolvedValue([1, 1]);

    const app = getApp();
    app.get("/v1/emails", (c) => c.json({ ok: true }));

    mockGetTeamFromToken.mockResolvedValueOnce(fullTeam({ apiKeyId: 11 }));
    await app.request("http://localhost/api/v1/emails", {
      headers: { Authorization: "Bearer project-a" },
    });

    mockGetTeamFromToken.mockResolvedValueOnce(fullTeam({ apiKeyId: 22 }));
    await app.request("http://localhost/api/v1/emails", {
      headers: { Authorization: "Bearer project-b" },
    });

    expect(mockRedis.eval.mock.calls[0]?.[2]).toBe("rl:api-key:11");
    expect(mockRedis.eval.mock.calls[1]?.[2]).toBe("rl:api-key:22");
  });

  it("fails closed with 503 when Redis cannot enforce the limiter", async () => {
    mockGetTeamFromToken.mockResolvedValue(fullTeam());
    mockRedis.eval.mockRejectedValue(new Error("redis unavailable"));

    const app = getApp();
    app.get("/v1/emails", (c) => c.json({ ok: true }));

    const response = await app.request("http://localhost/api/v1/emails", {
      headers: {
        Authorization: "Bearer test-key",
      },
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "SERVICE_UNAVAILABLE",
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
    mockRedis.eval.mockResolvedValue([1, 1]);

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

  it("denies a SENDING key access to management endpoints before rate limiting", async () => {
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
    expect(mockRedis.eval).not.toHaveBeenCalled();
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
    expect(mockRedis.eval).not.toHaveBeenCalled();
  });
});
