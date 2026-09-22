import { env } from "~/env";
import { confirmSubscription } from "~/server/aws/sns";
import { verifySnsMessageSignature } from "~/server/aws/sns-message-verifier";
import { db } from "~/server/db";
import { logger } from "~/server/logger/log";
import { SesHookParser } from "~/server/service/ses-hook-parser";
import { SesSettingsService } from "~/server/service/ses-settings-service";
import type { SnsNotificationMessage } from "~/types/aws-types";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ data: "Hello" });
}

export async function POST(req: Request) {
  let data: SnsNotificationMessage;

  try {
    data = (await req.json()) as SnsNotificationMessage;
  } catch {
    return Response.json({ data: "Invalid JSON payload" }, { status: 400 });
  }

  const validation = await validateSnsEvent(data);
  if (!validation.valid) {
    logger.warn(
      { topicArn: data?.TopicArn, reason: validation.reason },
      "Rejected invalid SNS callback",
    );
    return Response.json(
      { data: "Event is not valid" },
      { status: validation.status },
    );
  }

  if (data.Type === "SubscriptionConfirmation") {
    return handleSubscription(data);
  }

  if (data.Type !== "Notification") {
    return Response.json(
      { data: "Unsupported SNS message type" },
      { status: 400 },
    );
  }

  try {
    const message = JSON.parse(data.Message);
    const status = await SesHookParser.queue({
      event: message,
      messageId: data.MessageId,
    });

    if (!status) {
      return Response.json(
        { data: "Error in parsing hook" },
        { status: 500 },
      );
    }

    return Response.json({ data: "Success" });
  } catch (error) {
    logger.error({ err: error, messageId: data.MessageId }, "SNS hook failed");
    return Response.json({ data: "Error in parsing hook" }, { status: 400 });
  }
}

async function handleSubscription(message: SnsNotificationMessage) {
  const token = message.Token;
  if (!token) {
    return Response.json(
      { data: "Subscription token is missing" },
      { status: 400 },
    );
  }

  const setting = await db.sesSetting.findFirst({
    where: {
      topicArn: message.TopicArn,
    },
  });

  if (!setting) {
    return Response.json({ data: "Setting not found" }, { status: 404 });
  }

  await confirmSubscription(message.TopicArn, token, setting.region);

  await db.sesSetting.update({
    where: {
      id: setting.id,
    },
    data: {
      callbackSuccess: true,
    },
  });

  await SesSettingsService.invalidateCache();

  return Response.json({ data: "Success" });
}

async function validateSnsEvent(message: SnsNotificationMessage): Promise<
  | { valid: true }
  | { valid: false; status: number; reason: string }
> {
  if (
    !message ||
    typeof message.TopicArn !== "string" ||
    typeof message.MessageId !== "string" ||
    typeof message.Message !== "string" ||
    typeof message.Type !== "string"
  ) {
    return { valid: false, status: 400, reason: "malformed-message" };
  }

  const configuredTopicArns = await SesSettingsService.getTopicArns();
  if (!configuredTopicArns.includes(message.TopicArn)) {
    return { valid: false, status: 403, reason: "unknown-topic" };
  }

  if (shouldUseUnsignedLocalSns()) {
    return { valid: true };
  }

  const signatureValid = await verifySnsMessageSignature(message);
  if (!signatureValid) {
    return { valid: false, status: 403, reason: "invalid-signature" };
  }

  return { valid: true };
}

function shouldUseUnsignedLocalSns() {
  if (env.NODE_ENV !== "development" || !env.AWS_SNS_ENDPOINT) {
    return false;
  }

  try {
    const endpoint = new URL(env.AWS_SNS_ENDPOINT);
    return ["localhost", "127.0.0.1", "::1"].includes(endpoint.hostname);
  } catch {
    return false;
  }
}
