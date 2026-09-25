/**
 * Professional WhatsApp notice when a verified booking continuation
 * pickup resolves OUTSIDE_AREA. Message body is SSOT for Edge + locks.
 */

export const WHATSAPP_OUT_OF_AREA_NOTICE_TEXT =
  "*ONECAB*\n\n" +
  "Sorry, ONECAB is not currently available in your pickup area.\n\n" +
  "We’re expanding to more locations, and we hope to serve your area soon.\n\n" +
  "You can choose a different pickup location to continue.";

/** Metadata key on whatsapp_conversations — used for server-side dedupe. */
export const OUT_OF_AREA_NOTICE_META_KEY = "out_of_area_notice_sent_at";

/** Dedupe window: do not re-send within this many ms for the same wa_id. */
export const OUT_OF_AREA_NOTICE_DEDUPE_MS = 24 * 60 * 60 * 1000;

export function shouldSendOutOfAreaNotice(metadata: unknown, nowMs = Date.now()): boolean {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return true;
  const raw = (metadata as Record<string, unknown>)[OUT_OF_AREA_NOTICE_META_KEY];
  if (typeof raw !== "string" || !raw.trim()) return true;
  const sentAt = Date.parse(raw);
  if (!Number.isFinite(sentAt)) return true;
  return nowMs - sentAt >= OUT_OF_AREA_NOTICE_DEDUPE_MS;
}

export function withOutOfAreaNoticeSent(
  metadata: unknown,
  sentAtIso: string,
): Record<string, unknown> {
  const base =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? { ...(metadata as Record<string, unknown>) }
      : {};
  return { ...base, [OUT_OF_AREA_NOTICE_META_KEY]: sentAtIso };
}
