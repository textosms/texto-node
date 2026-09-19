import { createHmac, timingSafeEqual } from "node:crypto";
import type { DeliveryReceiptEvent, InboundEvent } from "./types.js";

/**
 * Verify the `X-Texto-Signature` header on an incoming webhook request.
 *
 * @param payload Raw request body, exactly as received (do not re-serialise).
 * @param signature Value of the `X-Texto-Signature` header, e.g. `sha256=abc...`.
 * @param secret Signing secret shown when you rotated the webhook secret.
 */
export function verifyWebhookSignature(
  payload: string | Uint8Array,
  signature: string | null | undefined,
  secret: string,
): boolean {
  if (!signature || !secret) return false;
  const provided = signature.startsWith("sha256=") ? signature.slice(7) : signature;
  const expected = createHmac("sha256", secret)
    .update(typeof payload === "string" ? payload : Buffer.from(payload))
    .digest("hex");
  const a = Buffer.from(provided, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Verify and parse a webhook body in one step.
 *
 * Throws when the signature does not match. Pass `secret: null` only if you
 * have not enabled signing.
 */
export function parseWebhookEvent(
  payload: string,
  signature: string | null | undefined,
  secret: string | null,
): DeliveryReceiptEvent | InboundEvent {
  if (secret && !verifyWebhookSignature(payload, signature, secret)) {
    throw new Error("Texto webhook signature verification failed");
  }
  return JSON.parse(payload) as DeliveryReceiptEvent | InboundEvent;
}

/** Type guard for inbound message webhooks. */
export function isInboundEvent(event: DeliveryReceiptEvent | InboundEvent): event is InboundEvent {
  return (event as InboundEvent).event === "message.inbound";
}
