import { describe, expect, it, vi } from "vitest";
import { consumeFixedWindowRateLimit } from "~/server/rate-limit";

describe("consumeFixedWindowRateLimit", () => {
  it("allows requests within the fixed window limit", async () => {
    const redis = {
      eval: vi.fn().mockResolvedValue([2, 1]),
    };

    const result = await consumeFixedWindowRateLimit({
      redis: redis as never,
      key: "rl:api-key:11",
      limit: 5,
      windowSeconds: 1,
      nowMs: 1_000_000,
    });

    expect(redis.eval).toHaveBeenCalledWith(
      expect.any(String),
      1,
      "rl:api-key:11",
      "1",
    );
    expect(result).toEqual({
      allowed: true,
      current: 2,
      remaining: 3,
      retryAfterSeconds: 1,
      resetAtUnixSeconds: 1001,
    });
  });

  it("denies requests above the limit and returns a bounded retry time", async () => {
    const redis = {
      eval: vi.fn().mockResolvedValue([6, 1]),
    };

    const result = await consumeFixedWindowRateLimit({
      redis: redis as never,
      key: "rl:api-key:11",
      limit: 5,
      windowSeconds: 1,
      nowMs: 1_000_000,
    });

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfterSeconds).toBe(1);
  });

  it("falls back to the requested window when Redis reports an invalid TTL", async () => {
    const redis = {
      eval: vi.fn().mockResolvedValue([1, -1]),
    };

    const result = await consumeFixedWindowRateLimit({
      redis: redis as never,
      key: "rl:api-key:11",
      limit: 5,
      windowSeconds: 10,
      nowMs: 2_000_000,
    });

    expect(result.retryAfterSeconds).toBe(10);
    expect(result.resetAtUnixSeconds).toBe(2010);
  });

  it("rejects invalid configuration", async () => {
    const redis = { eval: vi.fn() };

    await expect(
      consumeFixedWindowRateLimit({
        redis: redis as never,
        key: "rl",
        limit: 0,
        windowSeconds: 1,
      }),
    ).rejects.toThrow("positive integer");

    expect(redis.eval).not.toHaveBeenCalled();
  });

  it("rejects malformed Redis responses", async () => {
    const redis = {
      eval: vi.fn().mockResolvedValue("bad"),
    };

    await expect(
      consumeFixedWindowRateLimit({
        redis: redis as never,
        key: "rl",
        limit: 1,
        windowSeconds: 1,
      }),
    ).rejects.toThrow("Unexpected Redis rate-limit response");
  });
});
