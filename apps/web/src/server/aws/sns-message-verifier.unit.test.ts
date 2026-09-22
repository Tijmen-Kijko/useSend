import {
  createSign,
  generateKeyPairSync,
} from "crypto";
import { describe, expect, it } from "vitest";
import {
  buildSnsStringToSign,
  validateSnsSigningCertUrl,
  verifySnsMessageWithPublicKey,
} from "~/server/aws/sns-message-verifier";
import type { SnsNotificationMessage } from "~/types/aws-types";

function notification(
  overrides: Partial<SnsNotificationMessage> = {},
): SnsNotificationMessage {
  return {
    Type: "Notification",
    MessageId: "message-123",
    TopicArn: "arn:aws:sns:eu-west-1:123456789012:usesend-events",
    Subject: "Delivery event",
    Message: '{"eventType":"Delivery"}',
    Timestamp: "2026-09-22T06:00:00.000Z",
    SignatureVersion: "2",
    Signature: "",
    SigningCertURL:
      "https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-test.pem",
    UnsubscribeURL:
      "https://sns.eu-west-1.amazonaws.com/?Action=Unsubscribe",
    ...overrides,
  };
}

function subscription(
  overrides: Partial<SnsNotificationMessage> = {},
): SnsNotificationMessage {
  return notification({
    Type: "SubscriptionConfirmation",
    Subject: undefined,
    Message: "Please confirm your subscription",
    Token: "confirmation-token",
    SubscribeURL:
      "https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription",
    ...overrides,
  });
}

describe("SNS message verifier", () => {
  it("builds the canonical Notification string in AWS field order", () => {
    expect(buildSnsStringToSign(notification())).toBe(
      [
        "Message",
        '{"eventType":"Delivery"}',
        "MessageId",
        "message-123",
        "Subject",
        "Delivery event",
        "Timestamp",
        "2026-09-22T06:00:00.000Z",
        "TopicArn",
        "arn:aws:sns:eu-west-1:123456789012:usesend-events",
        "Type",
        "Notification",
        "",
      ].join("\n"),
    );
  });

  it("builds the canonical SubscriptionConfirmation string", () => {
    expect(buildSnsStringToSign(subscription())).toBe(
      [
        "Message",
        "Please confirm your subscription",
        "MessageId",
        "message-123",
        "SubscribeURL",
        "https://sns.eu-west-1.amazonaws.com/?Action=ConfirmSubscription",
        "Timestamp",
        "2026-09-22T06:00:00.000Z",
        "Token",
        "confirmation-token",
        "TopicArn",
        "arn:aws:sns:eu-west-1:123456789012:usesend-events",
        "Type",
        "SubscriptionConfirmation",
        "",
      ].join("\n"),
    );
  });

  it("accepts an SNS signing certificate URL matching the TopicArn region", () => {
    expect(
      validateSnsSigningCertUrl(
        "https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-abc123.pem",
        "arn:aws:sns:eu-west-1:123456789012:usesend-events",
      ).href,
    ).toBe(
      "https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-abc123.pem",
    );
  });

  it.each([
    "http://sns.eu-west-1.amazonaws.com/SimpleNotificationService-abc.pem",
    "https://sns.eu-west-1.amazonaws.com.attacker.test/SimpleNotificationService-abc.pem",
    "https://sns.us-east-1.amazonaws.com/SimpleNotificationService-abc.pem",
    "https://sns.eu-west-1.amazonaws.com/other.pem",
    "https://user@sns.eu-west-1.amazonaws.com/SimpleNotificationService-abc.pem",
    "https://sns.eu-west-1.amazonaws.com/SimpleNotificationService-abc.pem?redirect=1",
  ])("rejects untrusted certificate URL %s", (url) => {
    expect(() =>
      validateSnsSigningCertUrl(
        url,
        "arn:aws:sns:eu-west-1:123456789012:usesend-events",
      ),
    ).toThrow();
  });

  it("verifies a valid SignatureVersion 2 message and rejects tampering", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });

    const message = notification();
    const signer = createSign("RSA-SHA256");
    signer.update(buildSnsStringToSign(message), "utf8");
    signer.end();
    message.Signature = signer.sign(privateKey).toString("base64");

    expect(verifySnsMessageWithPublicKey(message, publicKey)).toBe(true);
    expect(
      verifySnsMessageWithPublicKey(
        { ...message, Message: '{"eventType":"Bounce"}' },
        publicKey,
      ),
    ).toBe(false);
  });

  it("verifies a valid SignatureVersion 1 message", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });

    const message = notification({ SignatureVersion: "1" });
    const signer = createSign("RSA-SHA1");
    signer.update(buildSnsStringToSign(message), "utf8");
    signer.end();
    message.Signature = signer.sign(privateKey).toString("base64");

    expect(verifySnsMessageWithPublicKey(message, publicKey)).toBe(true);
  });

  it("rejects unsupported signature versions", () => {
    expect(
      verifySnsMessageWithPublicKey(
        notification({ SignatureVersion: "3", Signature: "invalid" }),
        "invalid-key",
      ),
    ).toBe(false);
  });
});
