/** Offline test/audit-only helpers; not part of Edge uploads. */
import { PayoutControlCentreSettings, PayoutControlCentreDriverFlags, PayoutControlCentreDecision, applyRule } from "../../../functions/_shared/payoutControlCentreSettingsSSOT.ts";


/**
 * Apply control-centre policy to an already-computed Available Payout amount.
 * Never recalculates earnings — only gates and caps.
 */
export function applyPayoutControlCentrePolicy(
  availablePayoutPence: number,
  settings: PayoutControlCentreSettings,
  flags: PayoutControlCentreDriverFlags,
): PayoutControlCentreDecision {
  const reasons: string[] = [];
  let hold = false;

  if (!settings.payouts_enabled) {
    return { allowed: false, hold: false, amount_pence: 0, reasons: ["PAYOUTS_DISABLED"] };
  }
  if (settings.payout_frequency === "manual_only") {
    return { allowed: false, hold: false, amount_pence: 0, reasons: ["MANUAL_ONLY_SCHEDULE"] };
  }

  const neg = applyRule(
    settings.payout_rule_negative_wallet,
    flags.wallet_balance_pence < 0,
    "NEGATIVE_WALLET",
    reasons,
  );
  const disputes = applyRule(
    settings.payout_rule_pending_disputes,
    Boolean(flags.has_pending_disputes),
    "PENDING_DISPUTES",
    reasons,
  );
  const chargebacks = applyRule(
    settings.payout_rule_pending_chargebacks,
    Boolean(flags.has_pending_chargebacks),
    "PENDING_CHARGEBACKS",
    reasons,
  );
  const review = applyRule(
    settings.payout_rule_manual_review,
    Boolean(flags.manual_review_required),
    "MANUAL_REVIEW",
    reasons,
  );
  const suspended = applyRule(
    settings.payout_rule_suspended_driver,
    Boolean(flags.is_suspended),
    "SUSPENDED_DRIVER",
    reasons,
  );
  const expired = applyRule(
    settings.payout_rule_expired_documents,
    Boolean(flags.has_expired_documents),
    "EXPIRED_DOCUMENTS",
    reasons,
  );

  if (neg.block || disputes.block || chargebacks.block || review.block || suspended.block || expired.block) {
    return { allowed: false, hold: false, amount_pence: 0, reasons };
  }
  hold = neg.hold || disputes.hold || chargebacks.hold || review.hold || suspended.hold || expired.hold;

  let amount = Math.max(0, Math.round(availablePayoutPence));
  if (settings.payout_max_pence != null) {
    amount = Math.min(amount, settings.payout_max_pence);
  }
  if (amount < settings.payout_min_pence) {
    return {
      allowed: false,
      hold,
      amount_pence: 0,
      reasons: [...reasons, "BELOW_MIN_PAYOUT"],
    };
  }
  if (hold) {
    return { allowed: false, hold: true, amount_pence: amount, reasons };
  }
  return { allowed: true, hold: false, amount_pence: amount, reasons };
}


/** Validate an instant cash-out request against control-centre limits (no earnings math). */
export function applyInstantCashoutPolicy(
  requestedPence: number,
  settings: PayoutControlCentreSettings,
  requestsToday: number,
): { allowed: boolean; reasons: string[]; fee_pence: number } {
  const reasons: string[] = [];
  const amount = Math.max(0, Math.round(requestedPence));
  if (amount < settings.early_cashout_min_pence) reasons.push("BELOW_MIN_CASHOUT");
  if (settings.early_cashout_max_pence != null && amount > settings.early_cashout_max_pence) {
    reasons.push("ABOVE_MAX_CASHOUT");
  }
  if (requestsToday >= settings.early_cashout_max_per_day) reasons.push("MAX_CASHOUTS_PER_DAY");
  return {
    allowed: reasons.length === 0,
    reasons,
    fee_pence: settings.early_cashout_fee_pence,
  };
}

export * from "../../../functions/_shared/payoutControlCentreSettingsSSOT.ts";
