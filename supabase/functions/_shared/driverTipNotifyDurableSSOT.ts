/**
 * DT1 — Durable Driver tip-received heads-up SSOT (pure).
 * Separate from SN1 Customer lifecycle notify.
 *
 * pending → sending → sent | skipped | failed | ambiguous
 * Ambiguous is terminal (observable, no blind retry).
 */

export const DT1_SEND_LEASE_MS = 90_000;
export const DT1_MAX_ATTEMPTS = 8;

export type DriverTipDeliveryStatus =
  | "pending"
  | "sending"
  | "sent"
  | "skipped"
  | "failed"
  | "ambiguous";

export function buildDriverTipNotificationId(ledgerId: string): string {
  return `driver_tip_received:${String(ledgerId ?? "").trim()}`;
}

export function isDriverTipNotificationId(notificationId: string): boolean {
  return /^driver_tip_received:[0-9a-f-]{36}$/i.test(
    String(notificationId ?? "").trim(),
  );
}

export function formatDriverTipAmountGbp(tipPence: number): string {
  const pence = Math.max(0, Math.round(Number(tipPence) || 0));
  return `£${(pence / 100).toFixed(2)}`;
}

export function driverTipReceivedCopy(tipPence: number): {
  title: string;
  body: string;
} {
  const amount = formatDriverTipAmountGbp(tipPence);
  return {
    title: `🎉 You've received a ${amount} tip!`,
    body: "Your passenger appreciated your service. Send them a thank you! ❤️",
  };
}

export function walletTipDeepLinkPath(ledgerId: string): string {
  return `/wallet?ledgerId=${String(ledgerId ?? "").trim()}`;
}

export type TipClaimDecision =
  | { action: "lease_sending"; reason: "pending" | "failed" | "sending_lease_expired" }
  | { action: "skip"; reason: "already_terminal" | "in_flight" | "max_attempts" | "missing" };

export function decideDriverTipSendLease(input: {
  existing: {
    status: string;
    updatedAtIso: string;
    attempts?: number | null;
  } | null;
  nowMs: number;
}): TipClaimDecision {
  if (!input.existing) return { action: "skip", reason: "missing" };
  const status = String(input.existing.status ?? "").trim().toLowerCase();
  const attempts = Number(input.existing.attempts ?? 0);
  if (status === "sent" || status === "skipped" || status === "ambiguous") {
    return { action: "skip", reason: "already_terminal" };
  }
  if (Number.isFinite(attempts) && attempts >= DT1_MAX_ATTEMPTS) {
    return { action: "skip", reason: "max_attempts" };
  }
  if (status === "pending" || status === "failed") {
    return {
      action: "lease_sending",
      reason: status === "pending" ? "pending" : "failed",
    };
  }
  if (status === "sending") {
    const updatedMs = Date.parse(String(input.existing.updatedAtIso));
    const stale =
      !Number.isFinite(updatedMs) ||
      input.nowMs - updatedMs >= DT1_SEND_LEASE_MS;
    if (stale) {
      return { action: "lease_sending", reason: "sending_lease_expired" };
    }
    return { action: "skip", reason: "in_flight" };
  }
  return { action: "skip", reason: "already_terminal" };
}

/** Anti-stale: tip credit row still owned by same driver with positive amount. */
export function isDriverTipNotifyObsolete(input: {
  ledger: {
    id?: string | null;
    type?: string | null;
    driverId?: string | null;
    amountPence?: number | null;
  } | null;
  claimedDriverId: string;
  claimedLedgerId: string;
}): { obsolete: boolean; reason?: string } {
  if (!input.ledger) {
    return { obsolete: true, reason: "ledger_missing" };
  }
  const ledgerId = String(input.ledger.id ?? "").trim();
  const claimed = String(input.claimedLedgerId ?? "").trim();
  if (!ledgerId || ledgerId !== claimed) {
    return { obsolete: true, reason: "ledger_mismatch" };
  }
  if (upper(input.ledger.type) !== "DRIVER_TIP_CREDIT") {
    return { obsolete: true, reason: "not_tip_credit" };
  }
  const driver = String(input.ledger.driverId ?? "").trim();
  if (!driver || driver !== String(input.claimedDriverId ?? "").trim()) {
    return { obsolete: true, reason: "driver_mismatch" };
  }
  if (Math.round(Number(input.ledger.amountPence) || 0) <= 0) {
    return { obsolete: true, reason: "non_positive_tip" };
  }
  return { obsolete: false };
}

function upper(v: string | null | undefined): string {
  return String(v ?? "").trim().toUpperCase();
}

export function resolveDriverTipDeliveryOutcome(input: {
  httpOk: boolean;
  sent: number | null;
  reason: string | null;
  throwError?: boolean;
}): {
  status: Exclude<DriverTipDeliveryStatus, "pending" | "sending">;
  skippedReason?: string;
  errorMessage?: string;
} {
  if (input.throwError) {
    return { status: "failed", errorMessage: "notify_threw" };
  }
  if (!input.httpOk) {
    return { status: "failed", errorMessage: "http_not_ok" };
  }
  const reason = String(input.reason ?? "").trim().toLowerCase();
  if (reason === "no_tokens" || reason === "no_authoritative_push_token") {
    return { status: "skipped", skippedReason: "no_tokens" };
  }
  if (typeof input.sent === "number" && input.sent > 0) {
    return { status: "sent" };
  }
  if (typeof input.sent === "number" && input.sent === 0) {
    return { status: "skipped", skippedReason: "sent_zero" };
  }
  return { status: "ambiguous", errorMessage: "provider_outcome_ambiguous" };
}
