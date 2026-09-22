import { beforeEach, describe, expect, it, vi } from "vitest";

const { env } = vi.hoisted(() => ({
  env: {
    AWS_ACCESS_KEY_ID: undefined as string | undefined,
    AWS_SECRET_ACCESS_KEY: undefined as string | undefined,
  },
}));

vi.mock("~/env", () => ({ env }));

import { getAwsCredentialOptions } from "~/server/aws/credentials";

describe("AWS credential options", () => {
  beforeEach(() => {
    env.AWS_ACCESS_KEY_ID = undefined;
    env.AWS_SECRET_ACCESS_KEY = undefined;
  });

  it("uses the AWS default credential chain when static credentials are omitted", () => {
    expect(getAwsCredentialOptions()).toEqual({});
  });

  it("returns explicit credentials when both values are configured", () => {
    env.AWS_ACCESS_KEY_ID = "access-key";
    env.AWS_SECRET_ACCESS_KEY = "secret-key";

    expect(getAwsCredentialOptions()).toEqual({
      credentials: {
        accessKeyId: "access-key",
        secretAccessKey: "secret-key",
      },
    });
  });

  it("rejects a partial static credential configuration", () => {
    env.AWS_ACCESS_KEY_ID = "access-key";

    expect(() => getAwsCredentialOptions()).toThrow(
      "must both be set or both be omitted",
    );

    env.AWS_ACCESS_KEY_ID = undefined;
    env.AWS_SECRET_ACCESS_KEY = "secret-key";

    expect(() => getAwsCredentialOptions()).toThrow(
      "must both be set or both be omitted",
    );
  });
});
