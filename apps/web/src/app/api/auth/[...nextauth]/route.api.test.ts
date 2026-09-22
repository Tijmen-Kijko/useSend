import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockHandler, mockRedis, mockLogger } = vi.hoisted(() => ({
  mockHandler: vi.fn(),
  mockRedis: {
    eval: vi.fn(),
  },
  mockLogger: {
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("next-auth", () => ({
  default: vi.fn(() => mockHandler),
}));

vi.mock("~/server/auth", () => ({
  authOptions: {},
}));

vi.mock("~/env", () => ({
  env: {
    AUTH_EMAIL_RATE_LIMIT: 5,
  },
}));

vi.mock("~/server/redis", () => ({
  getRedis: () => mockRedis,
  redisKey: (key: string) => key,
}));

vi.mock("~/server/logger/log", () => ({
  logger: mockLogger,
}));

import { POST } from "~/app/api/auth/[...nextauth]/route";

function emailSignInRequest(headers: HeadersInit = {}) {
  return new Request("https://usesend.kijko.nl/api/auth/signin/email", {
    method: "POST",
    headers,
  });
}

describe("NextAuth email sign-in rate limiting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHandler.mockResolvedValue(Response.json({ ok: true }));
  });

  it("allows requests within the limit", async () => {
    mockRedis.eval.mockResolvedValue([1, 60]);

    const response = await POST(
      emailSignInRequest({ "cf-connecting-ip": "203.0.113.10" }),
      {},
    );

    expect(response.status).toBe(200);
    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "auth-rl:203.0.113.10",
      "60",
    );
    expect(mockHandler).toHaveBeenCalledTimes(1);
  });

  it("prefers Cloudflare client IP over X-Forwarded-For", async () => {
    mockRedis.eval.mockResolvedValue([1, 60]);

    const response = await POST(
      emailSignInRequest({
        "cf-connecting-ip": "203.0.113.10",
        "x-forwarded-for": "198.51.100.99",
      }),
      {},
    );

    expect(response.status).toBe(200);
    expect(mockRedis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "auth-rl:203.0.113.10",
      "60",
    );
  });

  it("returns 429 with Retry-After when the limit is exceeded", async () => {
    mockRedis.eval.mockResolvedValue([6, 42]);

    const response = await POST(
      emailSignInRequest({ "cf-connecting-ip": "203.0.113.10" }),
      {},
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");
    expect(response.headers.get("X-RateLimit-Limit")).toBe("5");
    expect(response.headers.get("X-RateLimit-Remaining")).toBe("0");
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it("fails closed when no client IP can be determined", async () => {
    const response = await POST(emailSignInRequest(), {});

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "SERVICE_UNAVAILABLE",
      },
    });
    expect(mockRedis.eval).not.toHaveBeenCalled();
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it("fails closed when Redis is unavailable", async () => {
    mockRedis.eval.mockRejectedValue(new Error("redis unavailable"));

    const response = await POST(
      emailSignInRequest({ "cf-connecting-ip": "203.0.113.10" }),
      {},
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "SERVICE_UNAVAILABLE",
      },
    });
    expect(mockHandler).not.toHaveBeenCalled();
  });

  it("does not rate limit non-email auth endpoints", async () => {
    const request = new Request(
      "https://usesend.kijko.nl/api/auth/callback/github",
      { method: "POST" },
    );

    const response = await POST(request, {});

    expect(response.status).toBe(200);
    expect(mockRedis.eval).not.toHaveBeenCalled();
    expect(mockHandler).toHaveBeenCalledTimes(1);
  });
});
