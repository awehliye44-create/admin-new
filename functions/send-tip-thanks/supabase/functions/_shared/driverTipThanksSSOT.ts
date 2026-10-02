/**
 * Driver Tip Thanks eligibility. Acknowledgement only.
 * Never a wallet, capture, refund, invoice, or financial-report mutation.
 *
 * Customer App tips only. Corporate, WhatsApp, and Guest web are excluded
 * by isCustomerAppTipChannelEligible.
 */
import { isCustomerAppTipChannelEligible } from "./tipChannelEligibilitySSOT.ts";

export const DRIVER_TIP_THANKS_COPY = {
  driverTitle: "Customer tip received",
  driverHelper: "Let the customer know you appreciate it.",
  sendThanks: "Send thanks",
  thanksSent: "Thanks sent",
  customerTitle: "Thank you from your driver",
  customerBody: "Your driver appreciated your tip.",
  customerOk: "OK",
} as const;

export type DriverTipThanksDenyCode =
  | "NOT_OWNER"
  | "NOT_TIP_CREDIT"
  | "TIP_NOT_POSITIVE"
  | "CAPTURE_NOT_CONFIRMED"
  | "NOT_CUSTOMER_APP"
  | "ALREADY_SENT";

export type DriverTipThanksFacts = {
  driverOwnsRow: boolean;
  ledgerType: string;
  amountPence: number;
  captureConfirmed: boolean;
  bookingSource?: string | null;
  corporateAccountId?: string | null;
  alreadySent: boolean;
};

export function evaluateDriverTipThanks(
  facts: DriverTipThanksFacts,
): { ok: true } | { ok: false; code: DriverTipThanksDenyCode } {
  if (!facts.driverOwnsRow) return { ok: false, code: "NOT_OWNER" };
  if (facts.ledgerType !== "DRIVER_TIP_CREDIT") {
    return { ok: false, code: "NOT_TIP_CREDIT" };
  }
  if (!Number.isFinite(facts.amountPence) || facts.amountPence <= 0) {
    return { ok: false, code: "TIP_NOT_POSITIVE" };
  }
  if (!facts.captureConfirmed) return { ok: false, code: "CAPTURE_NOT_CONFIRMED" };
  if (
    !isCustomerAppTipChannelEligible({
      booking_source: facts.bookingSource,
      corporate_account_id: facts.corporateAccountId,
    })
  ) {
    return { ok: false, code: "NOT_CUSTOMER_APP" };
  }
  if (facts.alreadySent) return { ok: false, code: "ALREADY_SENT" };
  return { ok: true };
}

/** True only when a captured payment session confirms fare + tip capture. */
export function isTipCaptureConfirmed(session: {
  status?: string | null;
  capturedAt?: string | null;
  capturedAmountPence?: number | null;
} | null): boolean {
  if (!session) return false;
  const status = String(session.status ?? "").trim().toLowerCase();
  const capturedAt = String(session.capturedAt ?? "").trim();
  const amount = Number(session.capturedAmountPence ?? 0);
  return status === "captured" && capturedAt.length > 0 && Number.isFinite(amount) && amount > 0;
}
