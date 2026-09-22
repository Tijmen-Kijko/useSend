import { createPublicKey, createVerify, X509Certificate, type KeyObject } from "crypto";
import type { SnsNotificationMessage } from "~/types/aws-types";

const CERT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const CERT_FETCH_TIMEOUT_MS = 5_000;
const MAX_CERT_BYTES = 64 * 1024;

type CachedCertificate = {
  publicKey: KeyObject;
  expiresAt: number;
};

const certificateCache = new Map<string, CachedCertificate>();

function getTopicArnParts(topicArn: string) {
  const parts = topicArn.split(":");
  if (parts.length < 6 || parts[0] !== "arn" || parts[2] !== "sns") {
    throw new Error("Invalid SNS TopicArn");
  }

  const [, partition, , region] = parts;
  if (!partition || !region) {
    throw new Error("Invalid SNS TopicArn");
  }

  return { partition, region };
}

function getExpectedSnsHostname(topicArn: string) {
  const { partition, region } = getTopicArnParts(topicArn);

  if (partition === "aws-cn") {
    return `sns.${region}.amazonaws.com.cn`;
  }

  if (partition === "aws" || partition === "aws-us-gov") {
    return `sns.${region}.amazonaws.com`;
  }

  throw new Error("Unsupported AWS partition");
}

export function validateSnsSigningCertUrl(
  signingCertUrl: string,
  topicArn: string,
) {
  let url: URL;
  try {
    url = new URL(signingCertUrl);
  } catch {
    throw new Error("Invalid SNS SigningCertURL");
  }

  if (url.protocol !== "https:") {
    throw new Error("SNS SigningCertURL must use HTTPS");
  }

  if (url.username || url.password || (url.port && url.port !== "443")) {
    throw new Error("Invalid SNS SigningCertURL authority");
  }

  if (url.hostname !== getExpectedSnsHostname(topicArn)) {
    throw new Error("SNS SigningCertURL host does not match TopicArn region");
  }

  if (
    !/^\/SimpleNotificationService-[A-Za-z0-9_-]+\.pem$/.test(url.pathname)
  ) {
    throw new Error("Invalid SNS signing certificate path");
  }

  if (url.search || url.hash) {
    throw new Error("SNS SigningCertURL must not contain query or fragment");
  }

  return url;
}

export function buildSnsStringToSign(message: SnsNotificationMessage) {
  const fields =
    message.Type === "Notification"
      ? [
          "Message",
          "MessageId",
          ...(message.Subject !== undefined ? ["Subject"] : []),
          "Timestamp",
          "TopicArn",
          "Type",
        ]
      : message.Type === "SubscriptionConfirmation" ||
          message.Type === "UnsubscribeConfirmation"
        ? [
            "Message",
            "MessageId",
            "SubscribeURL",
            "Timestamp",
            "Token",
            "TopicArn",
            "Type",
          ]
        : null;

  if (!fields) {
    throw new Error(`Unsupported SNS message type: ${message.Type}`);
  }

  return fields
    .map((field) => {
      const value = message[field as keyof SnsNotificationMessage];
      if (typeof value !== "string" || value.length === 0) {
        throw new Error(`Missing SNS signature field: ${field}`);
      }
      return `${field}\n${value}\n`;
    })
    .join("");
}

export function verifySnsMessageWithPublicKey(
  message: SnsNotificationMessage,
  publicKey: KeyObject | string,
) {
  const algorithm =
    message.SignatureVersion === "1"
      ? "RSA-SHA1"
      : message.SignatureVersion === "2"
        ? "RSA-SHA256"
        : null;

  if (!algorithm) {
    return false;
  }

  try {
    const verifier = createVerify(algorithm);
    verifier.update(buildSnsStringToSign(message), "utf8");
    verifier.end();

    return verifier.verify(
      typeof publicKey === "string" ? createPublicKey(publicKey) : publicKey,
      Buffer.from(message.Signature, "base64"),
    );
  } catch {
    return false;
  }
}

async function fetchSnsSigningPublicKey(url: URL) {
  const cached = certificateCache.get(url.href);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.publicKey;
  }

  const response = await fetch(url, {
    method: "GET",
    redirect: "error",
    signal: AbortSignal.timeout(CERT_FETCH_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error("Failed to fetch SNS signing certificate");
  }

  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (contentLength > MAX_CERT_BYTES) {
    throw new Error("SNS signing certificate is too large");
  }

  const certificatePem = await response.text();
  if (Buffer.byteLength(certificatePem, "utf8") > MAX_CERT_BYTES) {
    throw new Error("SNS signing certificate is too large");
  }

  const certificate = new X509Certificate(certificatePem);
  const now = Date.now();
  const validFrom = Date.parse(certificate.validFrom);
  const validTo = Date.parse(certificate.validTo);

  if (
    !Number.isFinite(validFrom) ||
    !Number.isFinite(validTo) ||
    now < validFrom ||
    now > validTo
  ) {
    throw new Error("SNS signing certificate is not currently valid");
  }

  certificateCache.set(url.href, {
    publicKey: certificate.publicKey,
    expiresAt: Math.min(validTo, now + CERT_CACHE_TTL_MS),
  });

  return certificate.publicKey;
}

export async function verifySnsMessageSignature(
  message: SnsNotificationMessage,
) {
  try {
    const certUrl = validateSnsSigningCertUrl(
      message.SigningCertURL,
      message.TopicArn,
    );
    const publicKey = await fetchSnsSigningPublicKey(certUrl);
    return verifySnsMessageWithPublicKey(message, publicKey);
  } catch {
    return false;
  }
}
