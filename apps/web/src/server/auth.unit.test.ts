import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterUser } from "next-auth/adapters";

const mocks = vi.hoisted(() => {
  const env = {
    GITHUB_ID: "github-client-id",
    GITHUB_SECRET: "github-client-secret",
    NEXT_PUBLIC_IS_CLOUD: true,
    NEXTAUTH_URL: "https://usesend.example.com",
    ADMIN_EMAIL: undefined as string | undefined,
    SELF_HOSTED_ALLOWED_EMAILS: undefined as string | undefined,
  };

  const baseCreateUser = vi.fn();
  const accountFindUnique = vi.fn();
  const userFindUnique = vi.fn();
  const userFindFirst = vi.fn();
  const inviteFindFirst = vi.fn();
  const transactionUserFindFirst = vi.fn();
  const transactionInviteFindFirst = vi.fn();
  const transactionUserCreate = vi.fn();
  const executeRaw = vi.fn();
  const transaction = vi.fn(async (callback) =>
    callback({
      $executeRaw: executeRaw,
      user: {
        findFirst: transactionUserFindFirst,
        create: transactionUserCreate,
      },
      teamInvite: {
        findFirst: transactionInviteFindFirst,
      },
    }),
  );

  return {
    env,
    baseCreateUser,
    accountFindUnique,
    userFindUnique,
    userFindFirst,
    inviteFindFirst,
    transactionUserFindFirst,
    transactionInviteFindFirst,
    transactionUserCreate,
    executeRaw,
    transaction,
  };
});

vi.mock("next-auth", () => ({
  getServerSession: vi.fn(),
}));

vi.mock("@auth/prisma-adapter", () => ({
  PrismaAdapter: vi.fn(() => ({ createUser: mocks.baseCreateUser })),
}));

vi.mock("next-auth/providers/github", () => ({
  default: vi.fn((options) => ({ id: "github", options })),
}));

vi.mock("next-auth/providers/google", () => ({
  default: vi.fn((options) => ({ id: "google", options })),
}));

vi.mock("next-auth/providers/email", () => ({
  default: vi.fn((options) => ({ id: "email", options })),
}));

vi.mock("~/server/db", () => ({
  db: {
    account: {
      findUnique: mocks.accountFindUnique,
    },
    user: {
      findUnique: mocks.userFindUnique,
      findFirst: mocks.userFindFirst,
    },
    teamInvite: {
      findFirst: mocks.inviteFindFirst,
    },
    $transaction: mocks.transaction,
  },
}));

vi.mock("~/server/mailer", () => ({
  sendSignUpEmail: vi.fn(),
}));

vi.mock("~/env", () => ({ env: mocks.env }));

import {
  authOptions,
  canRegisterSelfHostedUser,
  SelfHostedRegistrationError,
} from "~/server/auth";

const newUser = {
  id: "new-user",
  name: "New User",
  email: "new@example.com",
  emailVerified: null,
  image: null,
  isBetaUser: false,
  isWaitlisted: false,
  isAdmin: false,
};

const newUserWithoutEmail = {
  ...newUser,
  email: null,
} as unknown as AdapterUser;

describe("authOptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.env.NEXT_PUBLIC_IS_CLOUD = true;
    mocks.env.ADMIN_EMAIL = undefined;
    mocks.env.SELF_HOSTED_ALLOWED_EMAILS = undefined;
    mocks.accountFindUnique.mockResolvedValue(null);
    mocks.userFindUnique.mockResolvedValue(null);
    mocks.userFindFirst.mockResolvedValue(null);
    mocks.inviteFindFirst.mockResolvedValue(null);
    mocks.transactionUserFindFirst.mockResolvedValue(null);
    mocks.transactionInviteFindFirst.mockResolvedValue(null);
    mocks.transactionUserCreate.mockResolvedValue({ ...newUser, id: 1 });
  });

  it("enables secure cookies for an HTTPS NextAuth URL", () => {
    expect(authOptions.useSecureCookies).toBe(true);
  });

  it("configures the GitHub provider with an explicit issuer", () => {
    const githubProvider = authOptions.providers.find(
      (provider) => provider.id === "github",
    );

    expect(githubProvider).toMatchObject({
      id: "github",
      options: {
        clientId: "github-client-id",
        clientSecret: "github-client-secret",
        issuer: "https://github.com/login/oauth",
      },
    });
  });

  it("marks ADMIN_EMAIL as admin case-insensitively in the session", async () => {
    mocks.env.ADMIN_EMAIL = "owner@example.com";
    const sessionCallback = authOptions.callbacks?.session;
    if (!sessionCallback) {
      throw new Error("Expected session callback");
    }

    const result = await sessionCallback({
      session: {
        user: {
          name: "Owner",
          email: "OWNER@example.com",
          image: null,
        },
        expires: "2099-01-01T00:00:00.000Z",
      },
      user: {
        ...newUser,
        id: 1,
        email: "OWNER@example.com",
      },
      token: {},
      trigger: "update",
      newSession: undefined,
    } as any);

    expect(result).toMatchObject({
      user: {
        isAdmin: true,
      },
    });
  });

  describe("self-hosted registration policy", () => {
    beforeEach(() => {
      mocks.env.NEXT_PUBLIC_IS_CLOUD = false;
    });

    it("allows the first user without an invite", async () => {
      await expect(
        canRegisterSelfHostedUser("first@example.com"),
      ).resolves.toBe(true);

      expect(mocks.inviteFindFirst).not.toHaveBeenCalled();
    });

    it("only allows ADMIN_EMAIL to bootstrap a restricted empty installation", async () => {
      mocks.env.ADMIN_EMAIL = "owner@example.com";
      mocks.env.SELF_HOSTED_ALLOWED_EMAILS =
        "owner@example.com,second-admin@example.com";

      await expect(
        canRegisterSelfHostedUser("OWNER@example.com"),
      ).resolves.toBe(true);
      await expect(
        canRegisterSelfHostedUser("second-admin@example.com"),
      ).resolves.toBe(false);
      await expect(canRegisterSelfHostedUser(null)).resolves.toBe(false);
    });

    it("rejects an allowlisted bootstrap when ADMIN_EMAIL is not in the allowlist", async () => {
      mocks.env.ADMIN_EMAIL = "owner@example.com";
      mocks.env.SELF_HOSTED_ALLOWED_EMAILS = "second-admin@example.com";

      await expect(
        canRegisterSelfHostedUser("owner@example.com"),
      ).resolves.toBe(false);
    });

    it("allows an existing user to sign in without an invite", async () => {
      mocks.userFindUnique.mockResolvedValue({ id: 1 });

      await expect(
        canRegisterSelfHostedUser("existing@example.com"),
      ).resolves.toBe(true);

      expect(mocks.userFindFirst).not.toHaveBeenCalled();
      expect(mocks.inviteFindFirst).not.toHaveBeenCalled();
    });

    it("allows an existing OAuth account to sign in without a callback email", async () => {
      mocks.accountFindUnique.mockResolvedValue({
        id: "account_1",
        user: { email: "existing@example.com" },
      });

      await expect(
        canRegisterSelfHostedUser(null, {
          provider: "github",
          providerAccountId: "github-user-id",
          type: "oauth",
        }),
      ).resolves.toBe(true);

      expect(mocks.accountFindUnique).toHaveBeenCalledWith({
        where: {
          provider_providerAccountId: {
            provider: "github",
            providerAccountId: "github-user-id",
          },
        },
        select: {
          id: true,
          user: {
            select: { email: true },
          },
        },
      });
      expect(mocks.userFindFirst).not.toHaveBeenCalled();
    });

    it("rejects an existing user removed from the self-hosted allowlist", async () => {
      mocks.env.SELF_HOSTED_ALLOWED_EMAILS = "allowed@example.com";
      mocks.userFindUnique.mockResolvedValue({ id: 1 });

      await expect(
        canRegisterSelfHostedUser("blocked@example.com"),
      ).resolves.toBe(false);

      expect(mocks.userFindUnique).not.toHaveBeenCalled();
    });

    it("rejects an existing OAuth account when its linked email is no longer allowed", async () => {
      mocks.env.SELF_HOSTED_ALLOWED_EMAILS = "allowed@example.com";
      mocks.accountFindUnique.mockResolvedValue({
        id: "account_1",
        user: { email: "blocked@example.com" },
      });

      await expect(
        canRegisterSelfHostedUser(null, {
          provider: "github",
          providerAccountId: "github-user-id",
          type: "oauth",
        }),
      ).resolves.toBe(false);
    });

    it("allows a new user with a matching invite", async () => {
      mocks.userFindFirst.mockResolvedValue({ id: 1 });
      mocks.inviteFindFirst.mockResolvedValue({ id: "invite_1" });

      await expect(
        canRegisterSelfHostedUser("invited@example.com"),
      ).resolves.toBe(true);

      expect(mocks.inviteFindFirst).toHaveBeenCalledWith({
        where: { email: "invited@example.com" },
        select: { id: true },
      });
    });

    it("requires invited users to also be on the configured allowlist", async () => {
      mocks.env.SELF_HOSTED_ALLOWED_EMAILS =
        "allowed@example.com,owner@example.com";
      mocks.userFindFirst.mockResolvedValue({ id: 1 });
      mocks.inviteFindFirst.mockResolvedValue({ id: "invite_1" });

      await expect(
        canRegisterSelfHostedUser("blocked@example.com"),
      ).resolves.toBe(false);
      expect(mocks.inviteFindFirst).not.toHaveBeenCalled();

      await expect(
        canRegisterSelfHostedUser("allowed@example.com"),
      ).resolves.toBe(true);
    });

    it("rejects a new user without a matching invite", async () => {
      mocks.userFindFirst.mockResolvedValue({ id: 1 });

      await expect(
        canRegisterSelfHostedUser("random@example.com"),
      ).resolves.toBe(false);
    });

    it("allows the first account when the provider returns no email", async () => {
      await expect(canRegisterSelfHostedUser(null)).resolves.toBe(true);
      expect(mocks.userFindUnique).not.toHaveBeenCalled();
    });

    it("rejects a later account when the provider returns no email", async () => {
      mocks.userFindFirst.mockResolvedValue({ id: 1 });

      await expect(canRegisterSelfHostedUser(null)).resolves.toBe(false);
      expect(mocks.inviteFindFirst).not.toHaveBeenCalled();
    });
  });

  describe("adapter user creation", () => {
    const createUser = authOptions.adapter?.createUser;

    if (!createUser) {
      throw new Error("Expected the auth adapter to support user creation");
    }

    it("keeps cloud user creation unchanged", async () => {
      mocks.baseCreateUser.mockResolvedValue({ ...newUser, id: 1 });

      await createUser(newUser);

      expect(mocks.baseCreateUser).toHaveBeenCalledWith(newUser);
      expect(mocks.transaction).not.toHaveBeenCalled();
    });

    it("atomically creates the first self-hosted user", async () => {
      mocks.env.NEXT_PUBLIC_IS_CLOUD = false;

      await expect(createUser(newUser)).resolves.toMatchObject({
        id: 1,
        email: newUser.email,
      });

      expect(mocks.transaction).toHaveBeenCalledOnce();
      expect(mocks.executeRaw).toHaveBeenCalledOnce();
      expect(mocks.executeRaw.mock.invocationCallOrder[0]!).toBeLessThan(
        mocks.transactionUserFindFirst.mock.invocationCallOrder[0]!,
      );
      expect(mocks.transactionInviteFindFirst).not.toHaveBeenCalled();
      expect(mocks.transactionUserCreate).toHaveBeenCalledWith({
        data: {
          name: newUser.name,
          email: newUser.email,
          emailVerified: newUser.emailVerified,
          image: newUser.image,
        },
      });
    });

    it("rejects a non-admin bootstrap when ADMIN_EMAIL is configured", async () => {
      mocks.env.NEXT_PUBLIC_IS_CLOUD = false;
      mocks.env.ADMIN_EMAIL = "owner@example.com";
      mocks.env.SELF_HOSTED_ALLOWED_EMAILS =
        "owner@example.com,new@example.com";

      await expect(createUser(newUser)).rejects.toBeInstanceOf(
        SelfHostedRegistrationError,
      );

      expect(mocks.transactionInviteFindFirst).not.toHaveBeenCalled();
      expect(mocks.transactionUserCreate).not.toHaveBeenCalled();
    });

    it("creates the configured admin as the first self-hosted user", async () => {
      mocks.env.NEXT_PUBLIC_IS_CLOUD = false;
      mocks.env.ADMIN_EMAIL = "owner@example.com";
      mocks.env.SELF_HOSTED_ALLOWED_EMAILS =
        "owner@example.com,second-admin@example.com";
      const adminUser = {
        ...newUser,
        email: "OWNER@example.com",
      };
      mocks.transactionUserCreate.mockResolvedValueOnce({
        ...adminUser,
        id: 1,
      });

      await expect(createUser(adminUser)).resolves.toMatchObject({
        id: 1,
        email: "OWNER@example.com",
      });

      expect(mocks.transactionInviteFindFirst).not.toHaveBeenCalled();
      expect(mocks.transactionUserCreate).toHaveBeenCalledOnce();
    });

    it("atomically creates the first self-hosted user without an email", async () => {
      mocks.env.NEXT_PUBLIC_IS_CLOUD = false;
      mocks.transactionUserCreate.mockResolvedValueOnce({
        ...newUserWithoutEmail,
        id: 1,
      });

      await expect(createUser(newUserWithoutEmail)).resolves.toMatchObject({
        id: 1,
        email: null,
      });

      expect(mocks.transactionInviteFindFirst).not.toHaveBeenCalled();
      expect(mocks.transactionUserCreate).toHaveBeenCalledWith({
        data: {
          name: newUser.name,
          email: null,
          emailVerified: newUser.emailVerified,
          image: newUser.image,
        },
      });
    });

    it("atomically creates an invited self-hosted user", async () => {
      mocks.env.NEXT_PUBLIC_IS_CLOUD = false;
      mocks.transactionUserFindFirst.mockResolvedValue({ id: 1 });
      mocks.transactionInviteFindFirst.mockResolvedValue({ id: "invite_1" });

      await expect(createUser(newUser)).resolves.toMatchObject({
        id: 1,
        email: newUser.email,
      });

      expect(mocks.transactionInviteFindFirst).toHaveBeenCalledWith({
        where: { email: newUser.email },
        select: { id: true },
      });
      expect(mocks.transactionUserCreate).toHaveBeenCalledWith({
        data: {
          name: newUser.name,
          email: newUser.email,
          emailVerified: newUser.emailVerified,
          image: newUser.image,
        },
      });
    });

    it("does not create an invited self-hosted user outside the allowlist", async () => {
      mocks.env.NEXT_PUBLIC_IS_CLOUD = false;
      mocks.env.SELF_HOSTED_ALLOWED_EMAILS = "allowed@example.com";
      mocks.transactionUserFindFirst.mockResolvedValue({ id: 1 });
      mocks.transactionInviteFindFirst.mockResolvedValue({ id: "invite_1" });

      await expect(createUser(newUser)).rejects.toBeInstanceOf(
        SelfHostedRegistrationError,
      );

      expect(mocks.transactionInviteFindFirst).not.toHaveBeenCalled();
      expect(mocks.transactionUserCreate).not.toHaveBeenCalled();
    });

    it("creates an invited self-hosted user that is on the allowlist", async () => {
      mocks.env.NEXT_PUBLIC_IS_CLOUD = false;
      mocks.env.SELF_HOSTED_ALLOWED_EMAILS =
        "new@example.com,owner@example.com";
      mocks.transactionUserFindFirst.mockResolvedValue({ id: 1 });
      mocks.transactionInviteFindFirst.mockResolvedValue({ id: "invite_1" });

      await expect(createUser(newUser)).resolves.toMatchObject({
        id: 1,
        email: newUser.email,
      });

      expect(mocks.transactionInviteFindFirst).toHaveBeenCalledOnce();
      expect(mocks.transactionUserCreate).toHaveBeenCalledOnce();
    });

    it("does not create an uninvited self-hosted user", async () => {
      mocks.env.NEXT_PUBLIC_IS_CLOUD = false;
      mocks.transactionUserFindFirst.mockResolvedValue({ id: 1 });

      await expect(createUser(newUser)).rejects.toBeInstanceOf(
        SelfHostedRegistrationError,
      );

      expect(mocks.transactionUserCreate).not.toHaveBeenCalled();
    });

    it("does not create a later self-hosted user without an email", async () => {
      mocks.env.NEXT_PUBLIC_IS_CLOUD = false;
      mocks.transactionUserFindFirst.mockResolvedValue({ id: 1 });

      await expect(createUser(newUserWithoutEmail)).rejects.toBeInstanceOf(
        SelfHostedRegistrationError,
      );

      expect(mocks.transaction).toHaveBeenCalledOnce();
      expect(mocks.transactionUserCreate).not.toHaveBeenCalled();
    });
  });
});
