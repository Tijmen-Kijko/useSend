import { createSign, generateKeyPairSync } from "crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { verifyCloudflareAccessJwt } from "~/server/cloudflare-access";

function encodePart(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function createToken({
  audience = "audience-1",
  email = "Tijmen@kijko.nl",
  expiresAt = 2_000,
  issuer = "https://test.cloudflareaccess.com",
  notBefore,
  privateKey,
}: {
  audience?: string | string[];
  email?: string;
  expiresAt?: number;
  issuer?: string;
  notBefore?: number;
  privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
}) {
  const header = encodePart({ alg: "RS256", kid: "test-key", typ: "JWT" });
  const payload = encodePart({
    aud: audience,
    email,
    exp: expiresAt,
    iss: issuer,
    nbf: notBefore,
  });
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  signer.end();
  const signature = signer.sign(privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function mockJwks() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const jwk = publicKey.export({ format: "jwk" });
  Object.assign(jwk, {
    alg: "RS256",
    kid: "test-key",
    use: "sig",
  });

  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(JSON.stringify({ keys: [jwk] }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
    ),
  );

  return privateKey;
}

describe("verifyCloudflareAccessJwt", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accepts a valid signed Access JWT and normalizes its email", async () => {
    const privateKey = mockJwks();
    const token = createToken({ privateKey });

    await expect(
      verifyCloudflareAccessJwt(token, {
        audience: "audience-1",
        nowSeconds: 1_000,
        teamDomain: "https://test.cloudflareaccess.com",
      }),
    ).resolves.toEqual({ email: "tijmen@kijko.nl" });
  });

  it("rejects the wrong Access audience", async () => {
    const privateKey = mockJwks();
    const token = createToken({
      issuer: "https://test-2.cloudflareaccess.com",
      privateKey,
    });

    await expect(
      verifyCloudflareAccessJwt(token, {
        audience: "different-audience",
        nowSeconds: 1_000,
        teamDomain: "https://test-2.cloudflareaccess.com",
      }),
    ).rejects.toThrow("audience mismatch");
  });

  it("rejects an expired Access JWT", async () => {
    const privateKey = mockJwks();
    const token = createToken({
      expiresAt: 900,
      issuer: "https://test-3.cloudflareaccess.com",
      privateKey,
    });

    await expect(
      verifyCloudflareAccessJwt(token, {
        audience: "audience-1",
        nowSeconds: 1_000,
        teamDomain: "https://test-3.cloudflareaccess.com",
      }),
    ).rejects.toThrow("expired");
  });

  it("rejects a JWT signed by an unknown key", async () => {
    mockJwks();
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const token = createToken({
      issuer: "https://test-4.cloudflareaccess.com",
      privateKey,
    });

    await expect(
      verifyCloudflareAccessJwt(token, {
        audience: "audience-1",
        nowSeconds: 1_000,
        teamDomain: "https://test-4.cloudflareaccess.com",
      }),
    ).rejects.toThrow("signature is invalid");
  });
});
