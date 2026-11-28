/** Offline test/audit-only helpers; not part of Edge uploads. */
import { readTripFinancialModelStamp, TRANSITIONAL_NULL_FINANCIAL_MODEL_IS_PLATFORM, SERVICE_AREA_FINANCIAL_MODEL, ServiceAreaCommissionWalletConfig, isCommissionWalletWorkflowEnabled, COMMISSION_WALLET_ENTRY_TYPE, CommissionWalletDerivedBalances, CommissionTopupStatus, CommissionWalletTopupReversalPlan, COMMISSION_TOPUP_STATUS, buildCommissionWalletTopupReversalIdempotencyKey, buildCommissionWalletTopupBonusReversalIdempotencyKey, canTransitionCommissionTopupStatus, CommissionWalletDispatchEligibilityPlan, requiredCommissionReserveMinor, CommissionWalletReservePlan, buildCommissionWalletReserveIdempotencyKey, CommissionWalletReserveReleasePlan, buildCommissionWalletReserveReleaseIdempotencyKey, commissionableFareMinor, CommissionWalletDeductionPlan, planCommissionWalletTripPromotion, REVENUE_SOURCE_COMMISSION_WALLET_DEDUCTION, buildCommissionWalletDeductionIdempotencyKey } from "../../../functions/_shared/commissionWalletSSOT.ts";


/**
 * Do not use on recovery / recapture / DWL / payout paths.
 * Kept so step F can flip the flag without hunting call sites on booking writers.
 */
export function resolveTripFinancialModelOrTransitionalPlatform(
  financialModel: string | null | undefined,
): string {
  const model = readTripFinancialModelStamp(financialModel);
  if (model) return model;
  if (TRANSITIONAL_NULL_FINANCIAL_MODEL_IS_PLATFORM) {
    return SERVICE_AREA_FINANCIAL_MODEL.PLATFORM_COLLECTED;
  }
  return "";
}


/** Driver App Commission Wallet visibility — Service Area SSOT only. */
export function shouldShowDriverCommissionWalletPage(
  config: ServiceAreaCommissionWalletConfig | null | undefined,
  _opts?: { commissionWalletTestAccess?: boolean | null },
): boolean {
  return isCommissionWalletWorkflowEnabled(config);
}


/** ADMIN_CREDIT / trip-independent CW credit is never a customer fare promotion. */
export function isAdminCommissionWalletCreditCustomerFarePromotion(row: {
  entry_type?: string | null;
  trip_id?: string | null;
}): boolean {
  void row;
  return false;
}


export function isPreservedAdminCommissionWalletCredit(row: {
  entry_type?: string | null;
  trip_id?: string | null;
}): boolean {
  const type = String(row.entry_type ?? "").toUpperCase();
  const tripId = row.trip_id == null ? "" : String(row.trip_id).trim();
  return type === COMMISSION_WALLET_ENTRY_TYPE.ADMIN_CREDIT && tripId === "";
}


/** Driver main-card balance — never expose purchased/promo/reserved breakdown. */
export function commissionWalletDisplayBalanceMinor(
  balances: Partial<CommissionWalletDerivedBalances> | null | undefined,
): number {
  if (balances == null) return 0;
  if (typeof balances.commission_wallet_balance_minor === "number") {
    return Math.round(balances.commission_wallet_balance_minor);
  }
  const purchased = Math.round(Number(balances.purchased_balance_minor) || 0);
  const promotional = Math.round(Number(balances.promotional_balance_minor) || 0);
  return purchased + promotional;
}


export function assertCommissionWalletDoesNotTouchDriverWalletLedger(): true {
  // Compile-time / test guard documentation — this module never imports driver wallet writers.
  return true;
}


/**
 * Provider reversal after SUCCEEDED top-up: TOP_UP_REVERSAL (+ bonus reverse).
 * Never deletes original credits.
 */
export function planCommissionWalletTopupReversal(input: {
  currentStatus: CommissionTopupStatus | string;
  topupAmountMinor: number;
  creditedLedgerEntryId?: string | null;
  bonusAmountMinor?: number | null;
  bonusCampaignId?: string | null;
  topupId: string;
}): CommissionWalletTopupReversalPlan {
  const status = String(input.currentStatus).toUpperCase();
  if (status === COMMISSION_TOPUP_STATUS.REVERSED) {
    return {
      ok: true,
      already_reversed: true,
      topup_amount_minor: Math.max(0, Math.round(Number(input.topupAmountMinor) || 0)),
      bonus_amount_minor: Math.max(0, Math.round(Number(input.bonusAmountMinor) || 0)),
      topup_reversal_idempotency_key: buildCommissionWalletTopupReversalIdempotencyKey(input.topupId),
      bonus_reversal_idempotency_key: input.bonusCampaignId
        ? buildCommissionWalletTopupBonusReversalIdempotencyKey(
          input.topupId,
          String(input.bonusCampaignId),
        )
        : null,
      campaign_id: input.bonusCampaignId ? String(input.bonusCampaignId) : null,
    };
  }
  if (!canTransitionCommissionTopupStatus(status, COMMISSION_TOPUP_STATUS.REVERSED)) {
    return {
      ok: false,
      error: `Cannot reverse top-up from status ${status}`,
      code: "INVALID_STATUS",
    };
  }
  if (!input.creditedLedgerEntryId) {
    return { ok: false, error: "Top-up was never credited", code: "NOT_CREDITED" };
  }
  const amount = Math.round(Number(input.topupAmountMinor) || 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Top-up amount must be > 0", code: "INVALID_AMOUNT" };
  }
  const bonus = Math.max(0, Math.round(Number(input.bonusAmountMinor) || 0));
  const campaignId = input.bonusCampaignId ? String(input.bonusCampaignId).trim() : "";
  return {
    ok: true,
    already_reversed: false,
    topup_amount_minor: amount,
    bonus_amount_minor: bonus,
    topup_reversal_idempotency_key: buildCommissionWalletTopupReversalIdempotencyKey(input.topupId),
    bonus_reversal_idempotency_key:
      bonus > 0 && campaignId
        ? buildCommissionWalletTopupBonusReversalIdempotencyKey(input.topupId, campaignId)
        : null,
    campaign_id: campaignId || null,
  };
}


// ── Phase 6 — Dispatch eligibility + commission reserve ─────────────────────

/** Convert tier commission percent (0–100) to basis points. */
export function commissionPercentToBps(percent: number): number {
  return Math.max(0, Math.round(Number(percent) * 100));
}


/** Prefer negotiated/final fare; else server estimated fare (minor units). */
export function estimatedFinalFareMinorFromTrip(trip: {
  final_customer_fare_pence?: number | null;
  final_fare_pence?: number | null;
  accepted_driver_offer_fare_pence?: number | null;
  estimated_total_pence?: number | null;
  estimated_fare?: number | null;
}): number {
  const candidates = [
    trip.final_customer_fare_pence,
    trip.final_fare_pence,
    trip.accepted_driver_offer_fare_pence,
    trip.estimated_total_pence,
    trip.estimated_fare != null ? Math.round(Number(trip.estimated_fare) * 100) : null,
  ];
  for (const c of candidates) {
    const n = Math.round(Number(c) || 0);
    if (n > 0) return n;
  }
  return 0;
}


/** Soft dispatch gate — read-only balance vs estimated commission. Never mutates wallet. */
export function planCommissionWalletDispatchEligibility(input: {
  gateApplies: boolean;
  estimatedFinalFareMinor: number;
  commissionRateBps: number;
  /** Current commission_wallet_balance (may be negative). */
  commissionWalletBalanceMinor?: number;
  /** @deprecated alias of commissionWalletBalanceMinor */
  usableCommissionBalanceMinor?: number;
  fixedPlatformChargeMinor?: number | null;
  includeFixedPlatformCharge?: boolean;
}): CommissionWalletDispatchEligibilityPlan {
  if (!input.gateApplies) {
    return { ok: false, code: "GATE_OFF", error: "Commission Wallet dispatch gate is off" };
  }
  const required = requiredCommissionReserveMinor({
    estimatedFinalFareMinor: input.estimatedFinalFareMinor,
    commissionRateBps: input.commissionRateBps,
    fixedPlatformChargeMinor: input.fixedPlatformChargeMinor,
    includeFixedPlatformCharge: input.includeFixedPlatformCharge === true,
  });
  if (!Number.isFinite(required) || required < 0) {
    return { ok: false, code: "INVALID_AMOUNT", error: "Invalid required commission" };
  }
  const balance = Math.round(
    Number(
      input.commissionWalletBalanceMinor
        ?? input.usableCommissionBalanceMinor
        ?? 0,
    ) || 0,
  );
  if (balance < required) {
    return {
      ok: true,
      eligible: false,
      required_reserve_minor: required,
      usable_commission_balance_minor: balance,
      code: "INSUFFICIENT_COMMISSION_WALLET_BALANCE",
      error: `Commission Wallet balance ${balance} < estimated commission ${required}`,
    };
  }
  return {
    ok: true,
    eligible: true,
    required_reserve_minor: required,
    usable_commission_balance_minor: balance,
  };
}


export function planCommissionWalletReserve(input: {
  gateApplies: boolean;
  estimatedFinalFareMinor: number;
  commissionRateBps: number;
  usableCommissionBalanceMinor: number;
  driverId: string;
  tripId: string;
  alreadyHasActiveReserve?: boolean;
  currentReserveAmountMinor?: number | null;
  fixedPlatformChargeMinor?: number | null;
  includeFixedPlatformCharge?: boolean;
}): CommissionWalletReservePlan {
  if (!input.gateApplies) {
    return { ok: false, code: "GATE_OFF", error: "Commission Wallet reservation does not apply" };
  }
  if (input.alreadyHasActiveReserve) {
    return { ok: false, code: "ALREADY_RESERVED", error: "Trip already has an active Commission Wallet reservation" };
  }
  const amount = requiredCommissionReserveMinor({
    estimatedFinalFareMinor: input.estimatedFinalFareMinor,
    commissionRateBps: input.commissionRateBps,
    fixedPlatformChargeMinor: input.fixedPlatformChargeMinor,
    includeFixedPlatformCharge: input.includeFixedPlatformCharge,
  });
  if (amount <= 0) {
    return { ok: false, code: "INVALID_AMOUNT", error: "Estimated commission reserve is zero" };
  }
  if (Math.round(Number(input.usableCommissionBalanceMinor) || 0) < amount) {
    return {
      ok: false,
      code: "INSUFFICIENT_BALANCE",
      error: "Commission Wallet usable balance is insufficient for atomic reservation",
    };
  }
  return {
    ok: true,
    amount_minor: amount,
    entry_type: COMMISSION_WALLET_ENTRY_TYPE.COMMISSION_RESERVE,
    direction: "debit",
    ledger_idempotency_key: buildCommissionWalletReserveIdempotencyKey(input.driverId, input.tripId),
  };
}


export function planCommissionWalletReserveRelease(input: {
  activeReserveAmountMinor: number | null | undefined;
  driverId: string;
  tripId: string;
  alreadyReleased?: boolean;
}): CommissionWalletReserveReleasePlan {
  if (input.alreadyReleased) {
    return { ok: false, code: "ALREADY_RELEASED", error: "Commission Wallet reservation already released" };
  }
  const amount = Math.max(0, Math.round(Number(input.activeReserveAmountMinor) || 0));
  if (amount <= 0) {
    return { ok: false, code: "NO_ACTIVE_RESERVE", error: "No active Commission Wallet reservation" };
  }
  return {
    ok: true,
    amount_minor: amount,
    entry_type: COMMISSION_WALLET_ENTRY_TYPE.COMMISSION_RESERVE_RELEASE,
    direction: "credit",
    ledger_idempotency_key: buildCommissionWalletReserveReleaseIdempotencyKey(
      input.driverId,
      input.tripId,
    ),
  };
}


/**
 * Plan completion deduction: customer promotion reduces CW effect, never driver entitlement.
 * Promo-first bucket consumption. One deduction (or subsidy credit) per trip.
 * Converts an active assignment reservation.
 */
export function planCommissionWalletDeduction(input: {
  gateApplies: boolean;
  /** Pre-promotion commissionable fare. */
  commissionableFareMinor: number;
  commissionRateBps: number;
  /** Ignored when lockedCustomerPromotionMinor is set — never post-promo settlement commission. */
  commissionEarnedMinor?: number | null;
  /** Locked customer `global_offer` pence. Never Admin Commission Wallet credit. */
  lockedCustomerPromotionMinor?: number | null;
  promotionalBalanceMinor: number;
  purchasedBalanceMinor: number;
  /** Current balance (may be negative). Alias kept for callers. */
  usableBalanceMinorAfterReserveRelease?: number;
  commissionWalletBalanceMinor?: number;
  tripId: string;
  alreadyDeducted?: boolean;
  hasActiveReserve?: boolean;
}): CommissionWalletDeductionPlan {
  if (!input.gateApplies) {
    return { ok: true, skipped: true, code: "GATE_OFF" };
  }
  if (input.alreadyDeducted) {
    return { ok: true, skipped: true, code: "ALREADY_DEDUCTED" };
  }

  const lockedPromo = Math.max(0, Math.round(Number(input.lockedCustomerPromotionMinor) || 0));
  const promotion = planCommissionWalletTripPromotion({
    prePromotionCommissionableMinor: input.commissionableFareMinor,
    lockedCustomerPromotionMinor: lockedPromo,
    commissionRateBps: input.commissionRateBps,
  });
  const earnedExplicit = input.commissionEarnedMinor;
  const gross = lockedPromo > 0
    ? promotion.gross_commission_minor
    : (earnedExplicit != null && Number.isFinite(Number(earnedExplicit))
      ? Math.max(0, Math.round(Number(earnedExplicit)))
      : promotion.gross_commission_minor);
  const effect = gross - lockedPromo;
  if (!Number.isFinite(gross) || gross < 0) {
    return { ok: false, code: "INVALID_AMOUNT", error: "Invalid commission amount" };
  }
  if (effect === 0) {
    return { ok: true, skipped: true, code: "ZERO_COMMISSION" };
  }

  const convertReserve = input.hasActiveReserve === true;

  if (effect < 0) {
    return {
      ok: true,
      skipped: false,
      outcome: "subsidy",
      commission_earned_minor: gross,
      amount_minor: 0,
      subsidy_minor: -effect,
      gross_commission_minor: gross,
      locked_customer_promotion_minor: lockedPromo,
      promotional_portion_minor: -effect,
      purchased_portion_minor: 0,
      entry_type: COMMISSION_WALLET_ENTRY_TYPE.COMMISSION_SUBSIDY_CREDIT,
      direction: "credit",
      ledger_idempotency_key: `cw_subsidy_${String(input.tripId).trim()}`.slice(0, 180),
      convert_active_reserve: convertReserve,
      revenue_source: REVENUE_SOURCE_COMMISSION_WALLET_DEDUCTION,
    };
  }

  const promo = Math.round(Number(input.promotionalBalanceMinor) || 0);
  const purchased = Math.round(Number(input.purchasedBalanceMinor) || 0);
  const fromPromo = Math.min(effect, Math.max(0, promo));
  const fromPurchased = effect - fromPromo;
  const balanceBefore = Math.round(
    Number(
      input.commissionWalletBalanceMinor
        ?? input.usableBalanceMinorAfterReserveRelease
        ?? (promo + purchased),
    ) || 0,
  );

  return {
    ok: true,
    skipped: false,
    outcome: "deduction",
    commission_earned_minor: gross,
    amount_minor: effect,
    shortfall_minor: Math.max(0, effect - Math.max(balanceBefore, 0)),
    promotional_portion_minor: fromPromo,
    purchased_portion_minor: fromPurchased,
    gross_commission_minor: gross,
    locked_customer_promotion_minor: lockedPromo,
    entry_type: COMMISSION_WALLET_ENTRY_TYPE.COMMISSION_DEDUCTION,
    direction: "debit",
    ledger_idempotency_key: buildCommissionWalletDeductionIdempotencyKey(input.tripId),
    convert_active_reserve: convertReserve,
    revenue_source: REVENUE_SOURCE_COMMISSION_WALLET_DEDUCTION,
  };
}


/** SA move must never auto-transfer balances across currency. */
export function planCommissionWalletServiceAreaMove(input: {
  fromServiceAreaId: string;
  toServiceAreaId: string;
  fromCurrency: string;
  toCurrency: string;
}): {
  preserveOldLedger: true;
  createDestinationAccountIfMissing: true;
  autoTransferBalance: false;
  requiresAuditedMigration: boolean;
  code?: "CROSS_CURRENCY_TRANSFER_PROHIBITED";
} {
  const fromCcy = String(input.fromCurrency ?? "").toUpperCase();
  const toCcy = String(input.toCurrency ?? "").toUpperCase();
  const crossCurrency = Boolean(fromCcy && toCcy && fromCcy !== toCcy);
  return {
    preserveOldLedger: true,
    createDestinationAccountIfMissing: true,
    autoTransferBalance: false,
    requiresAuditedMigration: true,
    ...(crossCurrency
      ? { code: "CROSS_CURRENCY_TRANSFER_PROHIBITED" as const }
      : {}),
  };
}

export * from "../../../functions/_shared/commissionWalletSSOT.ts";
export * from "../../../../shared/edgePresentation/commissionWalletSSOT.ts";
