import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  state,
  verifySnsMessageSignature,
  confirmSubscription,
  queue,
  getTopicArns,
  invalidateCache,
  findFirst,
  update,
} = vi.hoisted(() => ({
  state: {
    knownTopic: "arn:aws:sns:eu-west-1:123456789012:usesend-events",
  },
  verifySnsMessageSignature: vi.fn(),
  confirmSubscription: vi.fn(),
  queue: vi.fn(),
  getTopicArns: vi.fn(),
  invalidateCache: vi.fn(),
  findFirst: vi.fn(),
  update: vi.fn(),
}));

vi.mock("~/env", () => ({
  env: {
    NODE_ENV: "production",
    AWS_SNS_ENDPOINT: undefined,
  },
}));

vi.mock("~/server/aws/sns-message-verifier", () => ({
  verifySnsMessageSignature,
}));

vi.mock("~/server/aws/sns", () => ({
  confirmSubscription,
}));

vi.mock("~/server/service/ses-hook-parser", () => ({
  SesHookParser: { queue },
}));

vi.mock("~/server/service/ses-settings-service", () => ({
  SesSettingsService: {
    getTopicArns,
    invalidateCache,
  },
}));

vi.mock("~/server/db", () => ({
  db: {
    sesSetting: {
      findFirst,
      update,
    },
  },
}));

vi.mock("~/server/logger/log", () => ({
  logger: {
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { POST } from "~/app/api/ses_callback/route";

function baseMessage(overrides: Record<string, unknown> = {}) {
  return {
    Type: "Notification",
    MessageId: "message-123",
    TopicArn: state.knownTopic,
    Message: JSON.stringify({ eventType: "Delivery" }),
    Timestamp: "2026-09-22T06:00:00.000Z",
    SignatureVersion: "2",
    Signature: "signature",
    SigningCertURL:
      "https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-test.pem",
    ...overrides,
  };
}

function request(body: unknown) {
  return new Request("https://usesend.kijko.nl/api/ses_callback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("SES/SNS callback route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getTopicArns.mockResolvedValue([state.knownTopic]);
    verifySnsMessageSignature.mockResolvedValue(true);
    queue.mockResolvedValue({ id: "job-1" });
    invalidateCache.mockResolvedValue(undefined);
    confirmSubscription.mockResolvedValue("subscription-arn");
    findFirst.mockResolvedValue({
      id: "setting-1",
      topicArn: state.knownTopic,
      region: "eu-west-1",
    });
    update.mockResolvedValue({});
  });

  it("rejects malformed JSON", async () => {
    const response = await POST(
      new Request("https://usesend.kijko.nl/api/ses_callback", {
        method: "POST",
        body: "{",
      }),
    );

    expect(response.status).toBe(400);
  });

  it("rejects an unknown TopicArn before signature verification", async () => {
    const response = await POST(
      request(
        baseMessage({
          TopicArn: "arn:aws:sns:eu-west-1:123456789012:attacker-topic",
        }),
      ),
    );

    expect(response.status).toBe(403);
    expect(verifySnsMessageSignature).not.toHaveBeenCalled();
    expect(queue).not.toHaveBeenCalled();
  });

  it("rejects an invalid SNS signature", async () => {
    verifySnsMessageSignature.mockResolvedValue(false);

    const response = await POST(request(baseMessage()));

    expect(response.status).toBe(403);
    expect(queue).not.toHaveBeenCalled();
  });

  it("queues a verified Notification", async () => {
    const response = await POST(request(baseMessage()));

    expect(response.status).toBe(200);
    expect(queue).toHaveBeenCalledWith({
      event: { eventType: "Delivery" },
      messageId: "message-123",
    });
  });

  it("confirms a verified subscription through the SNS SDK", async () => {
    const response = await POST(
      request(
        baseMessage({
          Type: "SubscriptionConfirmation",
          Token: "confirmation-token",
          SubscribeURL: "https://attacker.invalid/should-not-be-fetched",
          Message: "Please confirm",
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(confirmSubscription).toHaveBeenCalledWith(
      state.knownTopic,
      "confirmation-token",
      "eu-west-1",
    );
    expect(update).toHaveBeenCalledWith({
      where: { id: "setting-1" },
      data: { callbackSuccess: true },
    });
    expect(invalidateCache).toHaveBeenCalled();
  });

  it("rejects subscription confirmations without a token", async () => {
    const response = await POST(
      request(
        baseMessage({
          Type: "SubscriptionConfirmation",
          Message: "Please confirm",
        }),
      ),
    );

    expect(response.status).toBe(400);
    expect(confirmSubscription).not.toHaveBeenCalled();
  });
});
