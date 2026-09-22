import { ApiPermission } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  API_PERMISSION_RULES,
  isApiKeyAuthorized,
} from "~/server/public-api/api-key-authorization";

const concretePath = (template: string) =>
  template
    .replace("{emailId}", "email_123")
    .replace("{id}", "42")
    .replace("{campaignId}", "campaign_123")
    .replace("{contactBookId}", "book_123")
    .replace("{contactId}", "contact_123");

describe("public API key authorization", () => {
  it("allows FULL keys for every explicitly mapped public API route", () => {
    for (const rule of API_PERMISSION_RULES) {
      expect(
        isApiKeyAuthorized({
          permission: ApiPermission.FULL,
          method: rule.method,
          path: concretePath(rule.path),
        }),
        `${rule.method} ${rule.path}`,
      ).toBe(true);
    }
  });

  it.each([
    ["POST", "/api/v1/emails"],
    ["POST", "/api/v1/emails/batch"],
    ["GET", "/api/v1/emails"],
    ["GET", "/api/v1/emails/email_123"],
    ["PATCH", "/api/v1/emails/email_123"],
    ["POST", "/api/v1/emails/email_123/cancel"],
  ])("allows SENDING keys for %s %s", (method, path) => {
    expect(
      isApiKeyAuthorized({
        permission: ApiPermission.SENDING,
        method,
        path,
      }),
    ).toBe(true);
  });

  it.each([
    ["GET", "/api/v1/domains"],
    ["POST", "/api/v1/domains"],
    ["GET", "/api/v1/contactBooks"],
    ["POST", "/api/v1/contactBooks/book_123/contacts"],
    ["GET", "/api/v1/campaigns"],
    ["POST", "/api/v1/campaigns"],
    ["GET", "/api/v1/analytics/email-time-series"],
  ])("denies SENDING keys for %s %s", (method, path) => {
    expect(
      isApiKeyAuthorized({
        permission: ApiPermission.SENDING,
        method,
        path,
      }),
    ).toBe(false);
  });

  it("default-denies unmapped routes even for FULL keys", () => {
    expect(
      isApiKeyAuthorized({
        permission: ApiPermission.FULL,
        method: "GET",
        path: "/api/v1/future-admin-endpoint",
      }),
    ).toBe(false);
  });

  it("does not authorize a mapped path with the wrong method", () => {
    expect(
      isApiKeyAuthorized({
        permission: ApiPermission.SENDING,
        method: "DELETE",
        path: "/api/v1/emails/email_123",
      }),
    ).toBe(false);
  });

  it("does not let a path parameter consume another path segment", () => {
    expect(
      isApiKeyAuthorized({
        permission: ApiPermission.SENDING,
        method: "GET",
        path: "/api/v1/emails/email_123/unmapped",
      }),
    ).toBe(false);
  });
});
