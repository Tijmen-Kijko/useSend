import type IORedis from "ioredis";

const FIXED_WINDOW_LUA = `
local current = redis.call("INCR", KEYS[1])
local ttl = redis.call("TTL", KEYS[1])

if current == 1 or ttl < 0 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end

return { current, ttl }
`;

export type RateLimitResult = {
  allowed: boolean;
  current: number;
  remaining: number;
  retryAfterSeconds: number;
  resetAtUnixSeconds: number;
};

export async function consumeFixedWindowRateLimit({
  redis,
  key,
  limit,
  windowSeconds,
  nowMs = Date.now(),
}: {
  redis: IORedis;
  key: string;
  limit: number;
  windowSeconds: number;
  nowMs?: number;
}): Promise<RateLimitResult> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("Rate limit must be a positive integer");
  }

  if (!Number.isInteger(windowSeconds) || windowSeconds < 1) {
    throw new Error("Rate limit window must be a positive integer");
  }

  const result = await redis.eval(
    FIXED_WINDOW_LUA,
    1,
    key,
    String(windowSeconds),
  );

  if (
    !Array.isArray(result) ||
    result.length < 2 ||
    typeof result[0] !== "number" ||
    typeof result[1] !== "number"
  ) {
    throw new Error("Unexpected Redis rate-limit response");
  }

  const [current, rawTtl] = result;
  const retryAfterSeconds = rawTtl > 0 ? rawTtl : windowSeconds;
  const remaining = Math.max(0, limit - current);

  return {
    allowed: current <= limit,
    current,
    remaining,
    retryAfterSeconds,
    resetAtUnixSeconds:
      Math.floor(nowMs / 1000) + retryAfterSeconds,
  };
}
