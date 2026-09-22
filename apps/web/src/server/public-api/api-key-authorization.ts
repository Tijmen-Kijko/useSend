import { ApiPermission } from "@prisma/client";

type ApiPermissionRule = {
  method: string;
  path: string;
  permissions: readonly ApiPermission[];
};

const FULL_ONLY = [ApiPermission.FULL] as const;
const EMAIL_LIFECYCLE = [ApiPermission.FULL, ApiPermission.SENDING] as const;

/**
 * Public API authorization matrix.
 *
 * New protected API routes are denied until they are explicitly added here.
 * This keeps API-key authorization default-deny rather than silently granting
 * new endpoints to existing keys.
 */
export const API_PERMISSION_RULES: readonly ApiPermissionRule[] = [
  // Email sending + status lifecycle: allowed for SENDING and FULL keys.
  { method: "POST", path: "/api/v1/emails", permissions: EMAIL_LIFECYCLE },
  { method: "POST", path: "/api/v1/emails/batch", permissions: EMAIL_LIFECYCLE },
  { method: "GET", path: "/api/v1/emails", permissions: EMAIL_LIFECYCLE },
  {
    method: "GET",
    path: "/api/v1/emails/{emailId}",
    permissions: EMAIL_LIFECYCLE,
  },
  {
    method: "PATCH",
    path: "/api/v1/emails/{emailId}",
    permissions: EMAIL_LIFECYCLE,
  },
  {
    method: "POST",
    path: "/api/v1/emails/{emailId}/cancel",
    permissions: EMAIL_LIFECYCLE,
  },

  // Domain administration: FULL only.
  { method: "GET", path: "/api/v1/domains", permissions: FULL_ONLY },
  { method: "POST", path: "/api/v1/domains", permissions: FULL_ONLY },
  { method: "GET", path: "/api/v1/domains/{id}", permissions: FULL_ONLY },
  { method: "DELETE", path: "/api/v1/domains/{id}", permissions: FULL_ONLY },
  {
    method: "PUT",
    path: "/api/v1/domains/{id}/verify",
    permissions: FULL_ONLY,
  },

  // Contacts + contact books: FULL only.
  { method: "GET", path: "/api/v1/contactBooks", permissions: FULL_ONLY },
  { method: "POST", path: "/api/v1/contactBooks", permissions: FULL_ONLY },
  {
    method: "GET",
    path: "/api/v1/contactBooks/{contactBookId}",
    permissions: FULL_ONLY,
  },
  {
    method: "PATCH",
    path: "/api/v1/contactBooks/{contactBookId}",
    permissions: FULL_ONLY,
  },
  {
    method: "DELETE",
    path: "/api/v1/contactBooks/{contactBookId}",
    permissions: FULL_ONLY,
  },
  {
    method: "GET",
    path: "/api/v1/contactBooks/{contactBookId}/contacts",
    permissions: FULL_ONLY,
  },
  {
    method: "POST",
    path: "/api/v1/contactBooks/{contactBookId}/contacts",
    permissions: FULL_ONLY,
  },
  {
    method: "GET",
    path: "/api/v1/contactBooks/{contactBookId}/contacts/{contactId}",
    permissions: FULL_ONLY,
  },
  {
    method: "PATCH",
    path: "/api/v1/contactBooks/{contactBookId}/contacts/{contactId}",
    permissions: FULL_ONLY,
  },
  {
    method: "PUT",
    path: "/api/v1/contactBooks/{contactBookId}/contacts/{contactId}",
    permissions: FULL_ONLY,
  },
  {
    method: "DELETE",
    path: "/api/v1/contactBooks/{contactBookId}/contacts/{contactId}",
    permissions: FULL_ONLY,
  },
  {
    method: "POST",
    path: "/api/v1/contactBooks/{contactBookId}/contacts/bulk",
    permissions: FULL_ONLY,
  },
  {
    method: "DELETE",
    path: "/api/v1/contactBooks/{contactBookId}/contacts/bulk",
    permissions: FULL_ONLY,
  },

  // Campaign administration: FULL only.
  { method: "GET", path: "/api/v1/campaigns", permissions: FULL_ONLY },
  { method: "POST", path: "/api/v1/campaigns", permissions: FULL_ONLY },
  {
    method: "GET",
    path: "/api/v1/campaigns/{campaignId}",
    permissions: FULL_ONLY,
  },
  {
    method: "DELETE",
    path: "/api/v1/campaigns/{campaignId}",
    permissions: FULL_ONLY,
  },
  {
    method: "POST",
    path: "/api/v1/campaigns/{campaignId}/schedule",
    permissions: FULL_ONLY,
  },
  {
    method: "POST",
    path: "/api/v1/campaigns/{campaignId}/pause",
    permissions: FULL_ONLY,
  },
  {
    method: "POST",
    path: "/api/v1/campaigns/{campaignId}/resume",
    permissions: FULL_ONLY,
  },

  // Analytics: FULL only.
  {
    method: "GET",
    path: "/api/v1/analytics/email-time-series",
    permissions: FULL_ONLY,
  },
  {
    method: "GET",
    path: "/api/v1/analytics/reputation-metrics",
    permissions: FULL_ONLY,
  },
];

function compilePathTemplate(template: string) {
  const escaped = template
    .replace(/[.*+?^$()|[\]\\]/g, "\\$&")
    .replace(/\{[^/{}]+\}/g, "[^/]+");

  return new RegExp(`^${escaped}$`);
}

const COMPILED_RULES = API_PERMISSION_RULES.map((rule) => ({
  ...rule,
  pattern: compilePathTemplate(rule.path),
}));

export function isApiKeyAuthorized({
  permission,
  method,
  path,
}: {
  permission: ApiPermission;
  method: string;
  path: string;
}) {
  const normalizedMethod = method.toUpperCase();

  const rule = COMPILED_RULES.find(
    (candidate) =>
      candidate.method === normalizedMethod && candidate.pattern.test(path),
  );

  return rule?.permissions.includes(permission) ?? false;
}
