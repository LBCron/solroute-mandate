import { createHmac, timingSafeEqual } from "node:crypto";
import {
  MultiHopperWebhookEvent,
  MultiHopperWebhookEventType,
} from "../types.js";

const VALID_EVENT_TYPES = new Set<MultiHopperWebhookEventType>([
  "transfer.quote_created",
  "transfer.deposit_confirmed",
  "transfer.processing",
  "transfer.phase_changed",
  "transfer.hop_complete",
  "transfer.completed",
  "transfer.failed",
  "transfer.expired",
  "transfer.refunded",
  "transfer.recoverable",
  "transfer.rescued",
  "transfer.rent_reclaimed",
  "payout.completed",
]);

/**
 * Generates an `x-multihopper-signature` hex HMAC-SHA256 digest.
 */
export function signMultiHopperWebhookPayload(
  rawBody: string | Buffer,
  secret: string
): string {
  return createHmac("sha256", secret).update(rawBody).digest("hex");
}

/**
 * Timing-safe verification of `x-multihopper-signature` header (`api-reference/webhooks/events.md`).
 * Safely guards against buffer length mismatches so `timingSafeEqual` never throws.
 */
export function verifyMultiHopperWebhookSignature(
  rawBody: string | Buffer,
  signatureHeader: string | undefined | null,
  secret: string
): boolean {
  if (!signatureHeader || !secret) {
    return false;
  }
  const normalizedSig = signatureHeader.trim().replace(/^sha256=/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(normalizedSig)) {
    return false;
  }
  const expectedHex = signMultiHopperWebhookPayload(rawBody, secret);
  const actualBuf = Buffer.from(normalizedSig.toLowerCase(), "utf8");
  const expectedBuf = Buffer.from(expectedHex.toLowerCase(), "utf8");
  if (actualBuf.length !== expectedBuf.length) {
    return false;
  }
  return timingSafeEqual(actualBuf, expectedBuf);
}

export type WebhookHandler<T = Record<string, unknown>> = (
  event: MultiHopperWebhookEvent<T>
) => Promise<void> | void;

/**
 * Deduplicating HMAC-verified MultiHopper lifecycle webhook processor
 * (handles the 5-attempt exponential retry schedule idempotently).
 */
export class MultiHopperWebhookRouter {
  private readonly secret: string;
  private readonly processedIds = new Set<string>();
  private readonly handlers = new Map<MultiHopperWebhookEventType | "*", WebhookHandler[]>();

  constructor(secret: string) {
    if (!secret || secret.trim().length < 8) {
      throw new Error("Webhook secret must be at least 8 characters");
    }
    this.secret = secret;
  }

  public on(eventType: MultiHopperWebhookEventType | "*", handler: WebhookHandler): void {
    const existing = this.handlers.get(eventType) ?? [];
    existing.push(handler);
    this.handlers.set(eventType, existing);
  }

  public async processRawWebhook(
    rawBody: string | Buffer,
    signatureHeader: string | undefined | null
  ): Promise<{ accepted: boolean; duplicate: boolean; event?: MultiHopperWebhookEvent }> {
    if (!verifyMultiHopperWebhookSignature(rawBody, signatureHeader, this.secret)) {
      return { accepted: false, duplicate: false };
    }

    const parsed = JSON.parse(
      typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")
    ) as MultiHopperWebhookEvent;

    if (!parsed || typeof parsed.id !== "string" || !VALID_EVENT_TYPES.has(parsed.type)) {
      throw new Error("Malformed MultiHopper webhook event payload");
    }

    if (this.processedIds.has(parsed.id)) {
      return { accepted: true, duplicate: true, event: parsed };
    }
    this.processedIds.add(parsed.id);

    const specific = this.handlers.get(parsed.type) ?? [];
    const wildcard = this.handlers.get("*") ?? [];
    for (const fn of [...specific, ...wildcard]) {
      await fn(parsed);
    }

    return { accepted: true, duplicate: false, event: parsed };
  }
}
