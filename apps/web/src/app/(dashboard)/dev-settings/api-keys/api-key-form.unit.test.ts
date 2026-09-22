import { describe, expect, it } from "vitest";
import {
  DEFAULT_API_KEY_FORM_VALUES,
  toCreateApiKeyInput,
} from "~/app/(dashboard)/dev-settings/api-keys/api-key-form";

describe("API key form security defaults", () => {
  it("defaults new application keys to SENDING permission", () => {
    expect(DEFAULT_API_KEY_FORM_VALUES).toMatchObject({
      permission: "SENDING",
      domainId: "all",
    });
  });

  it("preserves an explicit FULL permission choice", () => {
    expect(
      toCreateApiKeyInput({
        name: "admin automation",
        permission: "FULL",
        domainId: "all",
      }),
    ).toEqual({
      name: "admin automation",
      permission: "FULL",
      domainId: undefined,
    });
  });

  it("converts a selected project domain into a scoped key", () => {
    expect(
      toCreateApiKeyInput({
        name: "get-hands-prod",
        permission: "SENDING",
        domainId: "42",
      }),
    ).toEqual({
      name: "get-hands-prod",
      permission: "SENDING",
      domainId: 42,
    });
  });
});
