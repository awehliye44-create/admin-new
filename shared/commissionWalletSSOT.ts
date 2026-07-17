/**
 * P0 — Africa Driver Commission Wallet SSOT (Phase 1).
 *
 * Isolation: NEVER infer from country/currency/driver location.
 * Workflow is active only when Service Area is explicitly assigned:
 *   financial_model = DRIVER_COLLECTED_COMMISSION_WALLET
 *   AND commission_wallet_enabled = true
 *
 * UK/EU PLATFORM_COLLECTED paths must remain unchanged.
 * Do not write to driver_wallet_ledger from this module.
 */

export const SERVICE_AREA_FINANCIAL_MODEL = {
  PLATFORM_COLLECTED: "PLATFORM_COLLECTED",
  DRIVER_COLLECTED_COMMISSION_WALLET: "DRIVER_COLLECTED_COMMISSION_WALLET",
} as const;

export type ServiceAreaFinancialModel =
  typeof SERVICE_AREA_FINANCIAL_MODEL[keyof typeof SERVICE_AREA_FINANCIAL_MODEL];

export const CUSTOMER_PAYMENT_POLICY = {
  PLATFORM_PREPAID: "PLATFORM_PREPAID",
  DRIVER_COLLECTS_UPFRONT: "DRIVER_COLLECTS_UPFRONT",
} as const;

export type CustomerPaymentPolicy =
  typeof CUSTOMER_PAYMENT_POLICY[keyof typeof CUSTOMER_PAYMENT_POLICY];

export const COMMISSION_WALLET_ENTRY_TYPE = {
  TOP_UP_CREDIT: "TOP_UP_CREDIT",
  WELCOME_CREDIT: "WELCOME_CREDIT",
  PROMOTIONAL_CREDIT: "PROMOTIONAL_CREDIT",
  ADMIN_CREDIT: "ADMIN_CREDIT",
  COMMISSION_RESERVE: "COMMISSION_RESERVE",
  COMMISSION_RESERVE_RELEASE: "COMMISSION_RESERVE_RELEASE",
  COMMISSION_DEDUCTION: "COMMISSION_DEDUCTION",
  COMMISSION_DEDUCTION_REVERSAL: "COMMISSION_DEDUCTION_REVERSAL",
  TOP_UP_REVERSAL: "TOP_UP_REVERSAL",
  ADMIN_CORRECTION: "ADMIN_CORRECTION",
} as const;

export type CommissionWalletEntryType =
  typeof COMMISSION_WALLET_ENTRY_TYPE[keyof typeof COMMISSION_WALLET_ENTRY_TYPE];

export const DEFAULT_CASH_UPFRONT_POLICY_NOTICE =
  "Payment is payable directly to the driver upfront. The driver is responsible for collecting payment and may cancel the booking if payment is not provided.";

export const COMMISSION_WALLET_DRIVER_PAGE_DISCLAIMER =
  "This balance is used only to pay ONECAB commission. It cannot be withdrawn, paid out or transferred.";

export const REVENUE_SOURCE_COMMISSION_WALLET_DEDUCTION =
  "COMMISSION_WALLET_DEDUCTION" as const;

export type ServiceAreaCommissionWalletConfig = {
  financial_model: ServiceAreaFinancialModel | string | null | undefined;
  commission_wallet_enabled: boolean | null | undefined;
  commission_reserve_enabled?: boolean | null;
  customer_payment_policy?: CustomerPaymentPolicy | string | null;
  commission_wallet_currency?: string | null;
  commission_topup_provider?: string | null;
  commission_wallet_minimum_balance_minor?: number | null;
  cash_upfront_policy_notice?: string | null;
  welcome_credit_enabled?: boolean | null;
  welcome_credit_amount_minor?: number | null;
  welcome_credit_max_drivers?: number | null;
};

/**
 * Hard isolation gate — Service Area SSOT only.
 * Never use country, currency, or GPS.
 */
export function isCommissionWalletWorkflowEnabled(
  config: ServiceAreaCommissionWalletConfig | null | undefined,
): boolean {
  if (!config) return false;
  const model = String(config.financial_model ?? "").toUpperCase();
  return (
    model === SERVICE_AREA_FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET
    && config.commission_wallet_enabled === true
  );
}

/** True when SA must keep existing UK/EU PLATFORM_COLLECTED behaviour. */
export function isPlatformCollectedFinancialModel(
  config: ServiceAreaCommissionWalletConfig | null | undefined,
): boolean {
  if (!config) return true;
  if (isCommissionWalletWorkflowEnabled(config)) return false;
  const model = String(config.financial_model ?? "").toUpperCase();
  return (
    model === ""
    || model === SERVICE_AREA_FINANCIAL_MODEL.PLATFORM_COLLECTED
    || config.commission_wallet_enabled !== true
  );
}

/** Driver App Commission Wallet page visibility (Phase 3).
 * Requires BOTH:
 * 1) Service Area Africa workflow enabled
 * 2) Explicit internal test-driver flag (never country/GPS)
 */
export function shouldShowDriverCommissionWalletPage(
  config: ServiceAreaCommissionWalletConfig | null | undefined,
  opts?: { commissionWalletTestAccess?: boolean | null },
): boolean {
  return (
    isCommissionWalletWorkflowEnabled(config)
    && opts?.commissionWalletTestAccess === true
  );
}

export type DriverCommissionWalletPageAccessPlan =
  | {
    ok: true;
    page_visible: true;
  }
  | {
    ok: false;
    page_visible: false;
    code:
      | "WALLET_DISABLED"
      | "NOT_TEST_DRIVER"
      | "NO_SERVICE_AREA";
    error: string;
  };

export function planDriverCommissionWalletPageAccess(input: {
  config: ServiceAreaCommissionWalletConfig | null | undefined;
  commissionWalletTestAccess: boolean | null | undefined;
  hasServiceArea: boolean;
}): DriverCommissionWalletPageAccessPlan {
  if (!input.hasServiceArea) {
    return {
      ok: false,
      page_visible: false,
      code: "NO_SERVICE_AREA",
      error: "Driver has no service area assigned",
    };
  }
  if (input.commissionWalletTestAccess !== true) {
    return {
      ok: false,
      page_visible: false,
      code: "NOT_TEST_DRIVER",
      error: "Commission Wallet page is limited to internal test drivers",
    };
  }
  if (!isCommissionWalletWorkflowEnabled(input.config)) {
    return {
      ok: false,
      page_visible: false,
      code: "WALLET_DISABLED",
      error: "Commission Wallet is not enabled for this service area",
    };
  }
  return { ok: true, page_visible: true };
}

/** Dispatch eligibility gate — true when CW workflow + commission_reserve_enabled. */
export function shouldApplyCommissionWalletDispatchGate(
  config: ServiceAreaCommissionWalletConfig | null | undefined,
): boolean {
  return (
    isCommissionWalletWorkflowEnabled(config)
    && config?.commission_reserve_enabled === true
  );
}

/** Trip snapshot fields frozen at booking create (Phase 3+ writers). */
export type TripFinancialModelSnapshot = {
  financial_model: ServiceAreaFinancialModel;
  payment_collection_model: CustomerPaymentPolicy;
  commission_wallet_enabled: boolean;
  commission_rate_bps: number;
  currency: string;
  service_area_id: string;
  region_id: string | null;
};

export function buildTripFinancialModelSnapshot(input: {
  serviceAreaId: string;
  regionId?: string | null;
  currency: string;
  commissionRateBps: number;
  config: ServiceAreaCommissionWalletConfig;
}): TripFinancialModelSnapshot | null {
  if (!isCommissionWalletWorkflowEnabled(input.config)) return null;
  return {
    financial_model: SERVICE_AREA_FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET,
    payment_collection_model:
      (String(input.config.customer_payment_policy ?? "")
        === CUSTOMER_PAYMENT_POLICY.DRIVER_COLLECTS_UPFRONT
        ? CUSTOMER_PAYMENT_POLICY.DRIVER_COLLECTS_UPFRONT
        : CUSTOMER_PAYMENT_POLICY.DRIVER_COLLECTS_UPFRONT),
    commission_wallet_enabled: true,
    commission_rate_bps: Math.max(0, Math.round(Number(input.commissionRateBps) || 0)),
    currency: String(input.currency || input.config.commission_wallet_currency || "").toUpperCase(),
    service_area_id: input.serviceAreaId,
    region_id: input.regionId ?? null,
  };
}

export function requiredCommissionReserveMinor(input: {
  estimatedFinalFareMinor: number;
  commissionRateBps: number;
  fixedPlatformChargeMinor?: number | null;
  includeFixedPlatformCharge?: boolean;
}): number {
  const fare = Math.max(0, Math.round(Number(input.estimatedFinalFareMinor) || 0));
  const bps = Math.max(0, Math.round(Number(input.commissionRateBps) || 0));
  let reserve = Math.round((fare * bps) / 10_000);
  if (input.includeFixedPlatformCharge) {
    reserve += Math.max(0, Math.round(Number(input.fixedPlatformChargeMinor) || 0));
  }
  return Math.max(0, reserve);
}

export function commissionableFareMinor(input: {
  finalFareAfterNegotiationMinor: number;
  airportChargeMinor?: number | null;
  otherPassThroughMinor?: number | null;
  discountsMinor?: number | null;
}): number {
  const fare = Math.max(0, Math.round(Number(input.finalFareAfterNegotiationMinor) || 0));
  const airport = Math.max(0, Math.round(Number(input.airportChargeMinor) || 0));
  const passThrough = Math.max(0, Math.round(Number(input.otherPassThroughMinor) || 0));
  const discounts = Math.max(0, Math.round(Number(input.discountsMinor) || 0));
  return Math.max(0, fare - airport - passThrough - discounts);
}

export function onecabCommissionDeductionMinor(input: {
  commissionableFareMinor: number;
  commissionRateBps: number;
}): number {
  const fare = Math.max(0, Math.round(Number(input.commissionableFareMinor) || 0));
  const bps = Math.max(0, Math.round(Number(input.commissionRateBps) || 0));
  return Math.round((fare * bps) / 10_000);
}

/** Prefer promotional then purchased when consuming commission. */
export function splitCommissionConsumption(input: {
  deductionMinor: number;
  promotionalBalanceMinor: number;
  purchasedBalanceMinor: number;
}): { promotional_portion_minor: number; purchased_portion_minor: number } {
  const need = Math.max(0, Math.round(Number(input.deductionMinor) || 0));
  const promo = Math.max(0, Math.round(Number(input.promotionalBalanceMinor) || 0));
  const purchased = Math.max(0, Math.round(Number(input.purchasedBalanceMinor) || 0));
  const fromPromo = Math.min(need, promo);
  const fromPurchased = Math.min(need - fromPromo, purchased);
  return {
    promotional_portion_minor: fromPromo,
    purchased_portion_minor: fromPurchased,
  };
}

export type CommissionWalletDerivedBalances = {
  purchased_balance_minor: number;
  promotional_balance_minor: number;
  reserved_balance_minor: number;
  usable_commission_balance_minor: number;
  withdrawable_balance_minor: 0;
  payout_due_minor: 0;
};

export function deriveCommissionWalletBalances(input: {
  purchasedBalanceMinor: number;
  promotionalBalanceMinor: number;
  reservedBalanceMinor: number;
}): CommissionWalletDerivedBalances {
  const purchased = Math.max(0, Math.round(Number(input.purchasedBalanceMinor) || 0));
  const promotional = Math.max(0, Math.round(Number(input.promotionalBalanceMinor) || 0));
  const reserved = Math.max(0, Math.round(Number(input.reservedBalanceMinor) || 0));
  return {
    purchased_balance_minor: purchased,
    promotional_balance_minor: promotional,
    reserved_balance_minor: reserved,
    usable_commission_balance_minor: Math.max(0, purchased + promotional - reserved),
    withdrawable_balance_minor: 0,
    payout_due_minor: 0,
  };
}

/** Forbidden actions on Commission Wallet — UI/API must never expose these. */
export const COMMISSION_WALLET_FORBIDDEN_ACTIONS = [
  "Withdraw",
  "Cash Out",
  "Send Money",
  "Transfer",
  "Payout Settings",
  "Debt Recovery",
  "Set Balance",
  "Pay Driver",
  "Recover Debt",
] as const;

export function assertCommissionWalletDoesNotTouchDriverWalletLedger(): true {
  // Compile-time / test guard documentation — this module never imports driver wallet writers.
  return true;
}

/**
 * Phase 2 / Add Credit — Admin credit types (stored as metadata.credit_type + audit.credit_type).
 * Legacy aliases (WELCOME / PROMOTIONAL / MANUAL / CORRECTION) normalize via
 * normalizeAdminCommissionCreditType.
 */
export const ADMIN_COMMISSION_CREDIT_KIND = {
  WELCOME_CREDIT: "WELCOME_CREDIT",
  PROMOTIONAL_CREDIT: "PROMOTIONAL_CREDIT",
  GOODWILL_CREDIT: "GOODWILL_CREDIT",
  SUPPORT_CORRECTION: "SUPPORT_CORRECTION",
  OTHER: "OTHER",
  /** @deprecated Use WELCOME_CREDIT */
  WELCOME: "WELCOME",
  /** @deprecated Use PROMOTIONAL_CREDIT */
  PROMOTIONAL: "PROMOTIONAL",
  /** @deprecated Use OTHER */
  MANUAL: "MANUAL",
  /** @deprecated Use SUPPORT_CORRECTION */
  CORRECTION: "CORRECTION",
} as const;

export type AdminCommissionCreditKind =
  typeof ADMIN_COMMISSION_CREDIT_KIND[keyof typeof ADMIN_COMMISSION_CREDIT_KIND];

/** Canonical Add Credit types shown in Admin UI. */
export const ADMIN_COMMISSION_CREDIT_TYPES = [
  ADMIN_COMMISSION_CREDIT_KIND.WELCOME_CREDIT,
  ADMIN_COMMISSION_CREDIT_KIND.PROMOTIONAL_CREDIT,
  ADMIN_COMMISSION_CREDIT_KIND.GOODWILL_CREDIT,
  ADMIN_COMMISSION_CREDIT_KIND.SUPPORT_CORRECTION,
  ADMIN_COMMISSION_CREDIT_KIND.OTHER,
] as const;

export type AdminCommissionCreditType = typeof ADMIN_COMMISSION_CREDIT_TYPES[number];

/** Minimum trimmed length for mandatory “Why are you adding this credit?” */
export const ADMIN_COMMISSION_CREDIT_REASON_MIN_LENGTH = 10;

export function normalizeAdminCommissionCreditType(
  kind: string | null | undefined,
): AdminCommissionCreditType | null {
  const raw = String(kind ?? "").trim().toUpperCase();
  if (
    raw === ADMIN_COMMISSION_CREDIT_KIND.WELCOME
    || raw === ADMIN_COMMISSION_CREDIT_KIND.WELCOME_CREDIT
  ) {
    return ADMIN_COMMISSION_CREDIT_KIND.WELCOME_CREDIT;
  }
  if (
    raw === ADMIN_COMMISSION_CREDIT_KIND.PROMOTIONAL
    || raw === ADMIN_COMMISSION_CREDIT_KIND.PROMOTIONAL_CREDIT
  ) {
    return ADMIN_COMMISSION_CREDIT_KIND.PROMOTIONAL_CREDIT;
  }
  if (raw === ADMIN_COMMISSION_CREDIT_KIND.GOODWILL_CREDIT) {
    return ADMIN_COMMISSION_CREDIT_KIND.GOODWILL_CREDIT;
  }
  if (
    raw === ADMIN_COMMISSION_CREDIT_KIND.CORRECTION
    || raw === ADMIN_COMMISSION_CREDIT_KIND.SUPPORT_CORRECTION
  ) {
    return ADMIN_COMMISSION_CREDIT_KIND.SUPPORT_CORRECTION;
  }
  if (
    raw === ADMIN_COMMISSION_CREDIT_KIND.MANUAL
    || raw === ADMIN_COMMISSION_CREDIT_KIND.OTHER
  ) {
    return ADMIN_COMMISSION_CREDIT_KIND.OTHER;
  }
  return null;
}

export function adminCommissionCreditTypeLabel(creditType: string | null | undefined): string {
  switch (normalizeAdminCommissionCreditType(creditType) ?? String(creditType ?? "").toUpperCase()) {
    case ADMIN_COMMISSION_CREDIT_KIND.WELCOME_CREDIT:
      return "Welcome Credit";
    case ADMIN_COMMISSION_CREDIT_KIND.PROMOTIONAL_CREDIT:
      return "Promotional Credit";
    case ADMIN_COMMISSION_CREDIT_KIND.GOODWILL_CREDIT:
      return "Goodwill Credit";
    case ADMIN_COMMISSION_CREDIT_KIND.SUPPORT_CORRECTION:
      return "Support Correction";
    case ADMIN_COMMISSION_CREDIT_KIND.OTHER:
      return "Other";
    default:
      return String(creditType ?? "Credit");
  }
}

export type AdminCommissionCreditReasonResult =
  | { ok: true; reason: string }
  | {
    ok: false;
    error: string;
    code: "REASON_REQUIRED" | "REASON_TOO_SHORT";
  };

/** Mandatory reason — reject empty / whitespace-only / too-short. */
export function validateAdminCommissionCreditReason(
  reason: string | null | undefined,
): AdminCommissionCreditReasonResult {
  const trimmed = String(reason ?? "").trim();
  if (!trimmed) {
    return {
      ok: false,
      error: "Reason is required — explain why you are adding this credit",
      code: "REASON_REQUIRED",
    };
  }
  if (trimmed.length < ADMIN_COMMISSION_CREDIT_REASON_MIN_LENGTH) {
    return {
      ok: false,
      error: `Reason must be at least ${ADMIN_COMMISSION_CREDIT_REASON_MIN_LENGTH} characters`,
      code: "REASON_TOO_SHORT",
    };
  }
  return { ok: true, reason: trimmed };
}

/**
 * Default idempotency key for admin credits.
 * Includes direction so SUPPORT_CORRECTION credit vs debit never collide.
 */
export function buildAdminCommissionWalletCreditIdempotencyKey(input: {
  driverId: string;
  serviceAreaId: string;
  creditKind: string;
  amountMinor: number;
  reason: string;
  direction?: "credit" | "debit" | string | null;
}): string {
  const kind = normalizeAdminCommissionCreditType(input.creditKind)
    ?? String(input.creditKind ?? "").toUpperCase();
  const direction = kind === ADMIN_COMMISSION_CREDIT_KIND.SUPPORT_CORRECTION
    ? (input.direction === "debit" ? "debit" : "credit")
    : "credit";
  return `cw_admin_${input.driverId}_${input.serviceAreaId}_${kind}_${direction}_${Math.round(Number(input.amountMinor) || 0)}_${input.reason}`
    .slice(0, 180);
}

export type AdminCommissionCreditPlan = {
  ok: true;
  /** Spec: Admin Add Credit always posts immutable ADMIN_CREDIT (credit_type distinguishes kind). */
  entry_type: typeof COMMISSION_WALLET_ENTRY_TYPE.ADMIN_CREDIT;
  /** Canonical Add Credit type permanently stored on audit + ledger metadata. */
  credit_type: AdminCommissionCreditType;
  direction: "credit" | "debit";
  amount_minor: number;
  balance_bucket: "purchased" | "promotional";
  audit_action: string;
} | {
  ok: false;
  error: string;
  code: "FORBIDDEN_ACTION" | "INVALID_AMOUNT" | "INVALID_KIND" | "WALLET_DISABLED";
};

/** True for legacy WELCOME_CREDIT rows or ADMIN_CREDIT with credit_type WELCOME_CREDIT. */
export function isWelcomeCommissionWalletLedgerEntry(row: {
  entry_type?: string | null;
  metadata?: Record<string, unknown> | null | unknown;
}): boolean {
  const type = String(row.entry_type ?? "").toUpperCase();
  if (type === COMMISSION_WALLET_ENTRY_TYPE.WELCOME_CREDIT) return true;
  if (type !== COMMISSION_WALLET_ENTRY_TYPE.ADMIN_CREDIT) return false;
  const meta = (row.metadata && typeof row.metadata === "object")
    ? row.metadata as Record<string, unknown>
    : null;
  return normalizeAdminCommissionCreditType(
    String(meta?.credit_type ?? meta?.credit_kind ?? ""),
  ) === ADMIN_COMMISSION_CREDIT_KIND.WELCOME_CREDIT;
}

export function planAdminCommissionWalletCredit(input: {
  kind: AdminCommissionCreditKind | string;
  amountMinor: number;
  /** For SUPPORT_CORRECTION: credit increases, debit decreases (compensating). */
  correctionDirection?: "credit" | "debit";
  walletEnabled: boolean;
  forbiddenAction?: string | null;
}): AdminCommissionCreditPlan {
  if (input.forbiddenAction) {
    const forbidden = COMMISSION_WALLET_FORBIDDEN_ACTIONS.map((a) => a.toLowerCase());
    if (forbidden.includes(String(input.forbiddenAction).toLowerCase())) {
      return { ok: false, error: "Action not allowed on Commission Wallet", code: "FORBIDDEN_ACTION" };
    }
  }
  if (!input.walletEnabled) {
    return {
      ok: false,
      error: "Commission Wallet is not enabled for this service area",
      code: "WALLET_DISABLED",
    };
  }
  const amount = Math.round(Number(input.amountMinor) || 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "amount must be > 0", code: "INVALID_AMOUNT" };
  }

  const creditType = normalizeAdminCommissionCreditType(input.kind);
  if (!creditType) {
    return { ok: false, error: "Invalid credit type", code: "INVALID_KIND" };
  }

  const direction = creditType === ADMIN_COMMISSION_CREDIT_KIND.SUPPORT_CORRECTION
    && input.correctionDirection === "debit"
    ? "debit"
    : "credit";

  const auditActionByType: Record<AdminCommissionCreditType, string> = {
    [ADMIN_COMMISSION_CREDIT_KIND.WELCOME_CREDIT]: "admin_welcome_credit",
    [ADMIN_COMMISSION_CREDIT_KIND.PROMOTIONAL_CREDIT]: "admin_promotional_credit",
    [ADMIN_COMMISSION_CREDIT_KIND.GOODWILL_CREDIT]: "admin_goodwill_credit",
    [ADMIN_COMMISSION_CREDIT_KIND.SUPPORT_CORRECTION]: "admin_support_correction",
    [ADMIN_COMMISSION_CREDIT_KIND.OTHER]: "admin_manual_credit",
  };

  return {
    ok: true,
    entry_type: COMMISSION_WALLET_ENTRY_TYPE.ADMIN_CREDIT,
    credit_type: creditType,
    direction,
    amount_minor: amount,
    balance_bucket: "promotional",
    audit_action: auditActionByType[creditType],
  };
}

export type AdminCommissionCreditGateResult =
  | { ok: true }
  | {
    ok: false;
    error: string;
    code:
      | "DRIVER_NOT_FOUND"
      | "DRIVER_NOT_ASSIGNED_TO_SERVICE_AREA"
      /** @deprecated Prefer DRIVER_NOT_ASSIGNED_TO_SERVICE_AREA */
      | "DRIVER_NOT_IN_SERVICE_AREA"
      | "COMMISSION_WALLET_DISABLED"
      | "INVALID_FINANCIAL_MODEL"
      | "CURRENCY_MISMATCH"
      | "CURRENCY_REQUIRED"
      | "WELCOME_CREDIT_DISABLED"
      | "WELCOME_CREDIT_AMOUNT_MISMATCH"
      | "WELCOME_CREDIT_ALREADY_RECEIVED"
      | "WELCOME_CREDIT_MAX_DRIVERS_REACHED";
  };

/**
 * Canonical Add Credit assignment gate.
 * Uses drivers.service_area_id only — never trip/GPS/city/region-only inference.
 */
export function validateDriverCommissionWalletServiceAreaAssignment(input: {
  driverAssignedToServiceArea: boolean;
}): AdminCommissionCreditGateResult {
  if (!input.driverAssignedToServiceArea) {
    return {
      ok: false,
      error: "Driver is not assigned to this service area",
      code: "DRIVER_NOT_ASSIGNED_TO_SERVICE_AREA",
    };
  }
  return { ok: true };
}

/**
 * Full backend re-validation context before ADMIN_CREDIT.
 * Never trust Admin UI alone.
 */
export function validateAdminCommissionWalletCreditContext(input: {
  driverFound: boolean;
  /** Canonical drivers.service_area_id */
  driverServiceAreaId: string | null | undefined;
  selectedServiceAreaId: string;
  financialModel: string | null | undefined;
  commissionWalletEnabled: boolean | null | undefined;
  expectedCurrency: string | null | undefined;
  requestedCurrency: string | null | undefined;
}): AdminCommissionCreditGateResult {
  if (!input.driverFound) {
    return {
      ok: false,
      error: "Driver not found",
      code: "DRIVER_NOT_FOUND",
    };
  }

  const driverSa = String(input.driverServiceAreaId ?? "").trim();
  const selectedSa = String(input.selectedServiceAreaId ?? "").trim();
  if (!driverSa || !selectedSa || driverSa !== selectedSa) {
    return {
      ok: false,
      error: "Driver is not assigned to this service area",
      code: "DRIVER_NOT_ASSIGNED_TO_SERVICE_AREA",
    };
  }

  const model = String(input.financialModel ?? "").toUpperCase();
  if (model !== SERVICE_AREA_FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET) {
    return {
      ok: false,
      error: "Service area financial model must be DRIVER_COLLECTED_COMMISSION_WALLET",
      code: "INVALID_FINANCIAL_MODEL",
    };
  }

  if (input.commissionWalletEnabled !== true) {
    return {
      ok: false,
      error: "Commission Wallet is not enabled for this service area",
      code: "COMMISSION_WALLET_DISABLED",
    };
  }

  const expected = String(input.expectedCurrency ?? "").trim().toUpperCase();
  if (!expected) {
    return {
      ok: false,
      error: "Service area has no commission wallet currency configured",
      code: "CURRENCY_REQUIRED",
    };
  }

  const requested = String(input.requestedCurrency ?? "").trim().toUpperCase();
  if (!requested || requested !== expected) {
    return {
      ok: false,
      error: `currency must match service area (${expected})`,
      code: "CURRENCY_MISMATCH",
    };
  }

  return { ok: true };
}

/** True when a driver row is eligible for Admin Add Credit listing. */
export function isDriverEligibleForAdminCommissionCredit(input: {
  approvalStatus: string | null | undefined;
  driverStatus: string | null | undefined;
  deletedAt?: string | null;
  /** Canonical drivers.service_area_id */
  driverServiceAreaId: string | null | undefined;
  selectedServiceAreaId: string;
  includeInactive?: boolean;
}): boolean {
  if (input.deletedAt) return false;
  if (String(input.approvalStatus ?? "").toLowerCase() !== "approved") return false;
  const status = String(input.driverStatus ?? "").toLowerCase();
  if (!input.includeInactive && status !== "active") return false;
  if (input.includeInactive && (status === "deleted" || !status)) return false;
  return String(input.driverServiceAreaId ?? "") === String(input.selectedServiceAreaId ?? "");
}

/** Client search for Add Credit driver picker. */
export function matchesAdminCommissionCreditDriverSearch(
  driver: {
    id: string;
    driver_code?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    phone?: string | null;
    license_plate?: string | null;
  },
  search: string,
): boolean {
  const q = String(search ?? "").trim().toLowerCase();
  if (!q) return true;
  const name = `${driver.first_name ?? ""} ${driver.last_name ?? ""}`.trim().toLowerCase();
  const code = String(driver.driver_code ?? "").toLowerCase();
  const phone = String(driver.phone ?? "").toLowerCase();
  const plate = String(driver.license_plate ?? "").toLowerCase();
  const id = String(driver.id ?? "").toLowerCase();
  return (
    name.includes(q)
    || code.includes(q)
    || phone.includes(q)
    || plate.includes(q)
    || id.startsWith(q)
    || id.includes(q)
  );
}

/** Welcome credit SA policy — amount, per-driver once, max drivers cap. */
export function validateAdminWelcomeCredit(input: {
  creditKind: AdminCommissionCreditKind | string;
  welcomeCreditEnabled: boolean;
  welcomeCreditAmountMinor?: number | null;
  requestedAmountMinor: number;
  driverAlreadyHasWelcomeCredit: boolean;
  distinctWelcomeDriversCount: number;
  welcomeCreditMaxDrivers?: number | null;
}): AdminCommissionCreditGateResult {
  const kind = normalizeAdminCommissionCreditType(input.creditKind);
  if (kind !== ADMIN_COMMISSION_CREDIT_KIND.WELCOME_CREDIT) return { ok: true };

  if (!input.welcomeCreditEnabled) {
    return {
      ok: false,
      error: "Welcome credit is not enabled for this service area",
      code: "WELCOME_CREDIT_DISABLED",
    };
  }

  const configuredAmount = Math.round(Number(input.welcomeCreditAmountMinor) || 0);
  if (configuredAmount > 0 && input.requestedAmountMinor !== configuredAmount) {
    return {
      ok: false,
      error: `Welcome credit amount must match service area config (${configuredAmount} minor units)`,
      code: "WELCOME_CREDIT_AMOUNT_MISMATCH",
    };
  }

  if (input.driverAlreadyHasWelcomeCredit) {
    return {
      ok: false,
      error: "Driver already received welcome credit for this service area",
      code: "WELCOME_CREDIT_ALREADY_RECEIVED",
    };
  }

  const maxDrivers = Math.round(Number(input.welcomeCreditMaxDrivers) || 0);
  if (maxDrivers > 0 && input.distinctWelcomeDriversCount >= maxDrivers) {
    return {
      ok: false,
      error: "Welcome credit driver cap reached for this service area",
      code: "WELCOME_CREDIT_MAX_DRIVERS_REACHED",
    };
  }

  return { ok: true };
}

export type CommissionWalletOverviewCardSlice = {
  entry_type: string;
  amount_minor: number | null;
};

/** Full-history card totals from ledger slices (not recent-window only). */
export function aggregateCommissionWalletOverviewCards(
  rows: CommissionWalletOverviewCardSlice[],
): {
  commission_collected_minor: number;
  campaign_credits_minor: number;
  provider_topups_minor: number;
  reversals_minor: number;
} {
  let commission_collected_minor = 0;
  let campaign_credits_minor = 0;
  let provider_topups_minor = 0;
  let reversals_minor = 0;

  for (const row of rows) {
    const amount = Math.max(0, Math.round(Number(row.amount_minor) || 0));
    const type = String(row.entry_type ?? "").toUpperCase();
    if (type === COMMISSION_WALLET_ENTRY_TYPE.COMMISSION_DEDUCTION) {
      commission_collected_minor += amount;
    }
    if (
      type === COMMISSION_WALLET_ENTRY_TYPE.WELCOME_CREDIT
      || type === COMMISSION_WALLET_ENTRY_TYPE.PROMOTIONAL_CREDIT
    ) {
      campaign_credits_minor += amount;
    }
    if (type === COMMISSION_WALLET_ENTRY_TYPE.TOP_UP_CREDIT) {
      provider_topups_minor += amount;
    }
    if (type.includes("REVERSAL") || type === COMMISSION_WALLET_ENTRY_TYPE.TOP_UP_REVERSAL) {
      reversals_minor += amount;
    }
  }

  return {
    commission_collected_minor,
    campaign_credits_minor,
    provider_topups_minor,
    reversals_minor,
  };
}

export type CommissionWalletLedgerRowLike = {
  entry_type: string;
  amount_minor: number;
  direction: string;
  promotional_portion_minor?: number | null;
  purchased_portion_minor?: number | null;
};

/** Derive balances from immutable ledger rows (Phase 2 read model). */
export function deriveBalancesFromCommissionLedgerEntries(
  rows: CommissionWalletLedgerRowLike[],
): CommissionWalletDerivedBalances {
  let purchased = 0;
  let promotional = 0;
  let reserved = 0;

  for (const row of rows) {
    const amount = Math.max(0, Math.round(Number(row.amount_minor) || 0));
    const type = String(row.entry_type ?? "").toUpperCase();
    const dir = String(row.direction ?? "").toLowerCase();
    const sign = dir === "debit" ? -1 : 1;

    if (type === COMMISSION_WALLET_ENTRY_TYPE.TOP_UP_CREDIT) {
      purchased += amount;
      continue;
    }
    if (type === COMMISSION_WALLET_ENTRY_TYPE.TOP_UP_REVERSAL) {
      purchased -= amount;
      continue;
    }
    if (
      type === COMMISSION_WALLET_ENTRY_TYPE.WELCOME_CREDIT
      || type === COMMISSION_WALLET_ENTRY_TYPE.PROMOTIONAL_CREDIT
      || type === COMMISSION_WALLET_ENTRY_TYPE.ADMIN_CREDIT
    ) {
      promotional += amount * (sign > 0 ? 1 : -1);
      continue;
    }
    if (type === COMMISSION_WALLET_ENTRY_TYPE.ADMIN_CORRECTION) {
      promotional += amount * sign;
      continue;
    }
    if (type === COMMISSION_WALLET_ENTRY_TYPE.COMMISSION_RESERVE) {
      reserved += amount;
      continue;
    }
    if (type === COMMISSION_WALLET_ENTRY_TYPE.COMMISSION_RESERVE_RELEASE) {
      reserved -= amount;
      continue;
    }
    if (type === COMMISSION_WALLET_ENTRY_TYPE.COMMISSION_DEDUCTION) {
      const promoPart = Math.max(0, Math.round(Number(row.promotional_portion_minor) || 0));
      const purchasedPart = Math.max(0, Math.round(Number(row.purchased_portion_minor) || 0));
      if (promoPart + purchasedPart > 0) {
        promotional -= promoPart;
        purchased -= purchasedPart;
      } else {
        // Fallback: consume promo first then purchased
        const split = splitCommissionConsumption({
          deductionMinor: amount,
          promotionalBalanceMinor: Math.max(0, promotional),
          purchasedBalanceMinor: Math.max(0, purchased),
        });
        promotional -= split.promotional_portion_minor;
        purchased -= split.purchased_portion_minor;
      }
      continue;
    }
    if (type === COMMISSION_WALLET_ENTRY_TYPE.COMMISSION_DEDUCTION_REVERSAL) {
      const promoPart = Math.max(0, Math.round(Number(row.promotional_portion_minor) || 0));
      const purchasedPart = Math.max(0, Math.round(Number(row.purchased_portion_minor) || 0));
      promotional += promoPart || amount;
      purchased += purchasedPart;
    }
  }

  return deriveCommissionWalletBalances({
    purchasedBalanceMinor: purchased,
    promotionalBalanceMinor: promotional,
    reservedBalanceMinor: reserved,
  });
}

// ── Phase 4 — Provider sandbox top-up ───────────────────────────────────────

export const COMMISSION_TOPUP_PROVIDER = {
  WAAFI_PAY: "waafi_pay",
} as const;

export const PHASE4_SUPPORTED_TOPUP_PROVIDERS = [
  COMMISSION_TOPUP_PROVIDER.WAAFI_PAY,
] as const;

export const COMMISSION_TOPUP_STATUS = {
  PENDING: "PENDING",
  PROCESSING: "PROCESSING",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  EXPIRED: "EXPIRED",
  REVERSED: "REVERSED",
} as const;

export type CommissionTopupStatus =
  typeof COMMISSION_TOPUP_STATUS[keyof typeof COMMISSION_TOPUP_STATUS];

/** True when SA has a Phase 4–supported top-up provider configured. */
export function isCommissionTopupProviderConfigured(
  provider: string | null | undefined,
): boolean {
  const p = String(provider ?? "").trim().toLowerCase();
  return (PHASE4_SUPPORTED_TOPUP_PROVIDERS as readonly string[]).includes(p);
}

/** Driver top-up CTA visibility — Phase 4. */
export function shouldEnableDriverCommissionWalletTopup(input: {
  config: ServiceAreaCommissionWalletConfig | null | undefined;
  commissionWalletTestAccess: boolean | null | undefined;
}): boolean {
  return (
    isCommissionWalletWorkflowEnabled(input.config)
    && input.commissionWalletTestAccess === true
    && isCommissionTopupProviderConfigured(input.config?.commission_topup_provider)
  );
}

export function canTransitionCommissionTopupStatus(
  from: CommissionTopupStatus | string,
  to: CommissionTopupStatus | string,
): boolean {
  const f = String(from).toUpperCase();
  const t = String(to).toUpperCase();
  if (f === t) return true;
  const allowed: Record<string, string[]> = {
    [COMMISSION_TOPUP_STATUS.PENDING]: [
      COMMISSION_TOPUP_STATUS.PROCESSING,
      COMMISSION_TOPUP_STATUS.FAILED,
      COMMISSION_TOPUP_STATUS.EXPIRED,
    ],
    [COMMISSION_TOPUP_STATUS.PROCESSING]: [
      COMMISSION_TOPUP_STATUS.SUCCEEDED,
      COMMISSION_TOPUP_STATUS.FAILED,
      COMMISSION_TOPUP_STATUS.EXPIRED,
    ],
    [COMMISSION_TOPUP_STATUS.SUCCEEDED]: [COMMISSION_TOPUP_STATUS.REVERSED],
    [COMMISSION_TOPUP_STATUS.FAILED]: [],
    [COMMISSION_TOPUP_STATUS.EXPIRED]: [],
    [COMMISSION_TOPUP_STATUS.REVERSED]: [],
  };
  return (allowed[f] ?? []).includes(t);
}

export function buildCommissionWalletTopupIdempotencyKey(input: {
  driverId: string;
  serviceAreaId: string;
  amountMinor: number;
  clientKey: string;
}): string {
  const client = String(input.clientKey ?? "").trim().slice(0, 64) || "default";
  return `cw_topup_${input.driverId}_${input.serviceAreaId}_${Math.round(Number(input.amountMinor) || 0)}_${client}`
    .slice(0, 180);
}

export function buildCommissionWalletTopupCreditIdempotencyKey(topupId: string): string {
  return `cw_topup_credit_${String(topupId).trim()}`.slice(0, 180);
}

export function buildCommissionWalletTopupReversalIdempotencyKey(topupId: string): string {
  return `cw_topup_reversal_${String(topupId).trim()}`.slice(0, 180);
}

export function buildCommissionWalletTopupBonusReversalIdempotencyKey(
  topupId: string,
  campaignId: string,
): string {
  return `cw_topup_bonus_reversal_${String(topupId).trim()}_${String(campaignId).trim()}`.slice(
    0,
    180,
  );
}

export type CommissionWalletTopupReversalPlan =
  | {
    ok: true;
    already_reversed: boolean;
    topup_amount_minor: number;
    bonus_amount_minor: number;
    topup_reversal_idempotency_key: string;
    bonus_reversal_idempotency_key: string | null;
    campaign_id: string | null;
  }
  | {
    ok: false;
    error: string;
    code: "INVALID_STATUS" | "NOT_CREDITED" | "INVALID_AMOUNT";
  };

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

export type CommissionWalletTopupInitiatePlan =
  | {
    ok: true;
    amount_minor: number;
    currency: string;
    provider: string;
    sandbox: true;
  }
  | {
    ok: false;
    error: string;
    code:
      | "WALLET_DISABLED"
      | "NOT_TEST_DRIVER"
      | "PROVIDER_NOT_CONFIGURED"
      | "PROVIDER_UNSUPPORTED"
      | "INVALID_AMOUNT"
      | "CURRENCY_MISMATCH";
  };

export function planCommissionWalletTopupInitiate(input: {
  walletEnabled: boolean;
  commissionWalletTestAccess: boolean;
  provider: string | null | undefined;
  amountMinor: number;
  currency: string;
  walletCurrency: string | null | undefined;
}): CommissionWalletTopupInitiatePlan {
  if (!input.walletEnabled) {
    return {
      ok: false,
      error: "Commission Wallet is not enabled for this service area",
      code: "WALLET_DISABLED",
    };
  }
  if (input.commissionWalletTestAccess !== true) {
    return {
      ok: false,
      error: "Top-up is limited to internal test drivers",
      code: "NOT_TEST_DRIVER",
    };
  }
  const provider = String(input.provider ?? "").trim().toLowerCase();
  if (!provider) {
    return {
      ok: false,
      error: "Top-up provider is not configured for this service area",
      code: "PROVIDER_NOT_CONFIGURED",
    };
  }
  if (!isCommissionTopupProviderConfigured(provider)) {
    return {
      ok: false,
      error: `Top-up provider '${provider}' is not supported in Phase 4 sandbox`,
      code: "PROVIDER_UNSUPPORTED",
    };
  }
  const amount = Math.round(Number(input.amountMinor) || 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "amount must be > 0", code: "INVALID_AMOUNT" };
  }
  const currency = String(input.currency ?? "").trim().toUpperCase();
  const walletCurrency = String(input.walletCurrency ?? "").trim().toUpperCase();
  if (!currency || !walletCurrency || currency !== walletCurrency) {
    return {
      ok: false,
      error: "Top-up currency must match Commission Wallet currency",
      code: "CURRENCY_MISMATCH",
    };
  }
  return {
    ok: true,
    amount_minor: amount,
    currency,
    provider,
    sandbox: true,
  };
}

export type CommissionWalletTopupConfirmPlan =
  | {
    ok: true;
    already_succeeded: boolean;
    entry_type: typeof COMMISSION_WALLET_ENTRY_TYPE.TOP_UP_CREDIT;
    direction: "credit";
    amount_minor: number;
    currency: string;
    purchased_portion_minor: number;
    promotional_portion_minor: number;
    ledger_idempotency_key: string;
  }
  | {
    ok: false;
    error: string;
    code:
      | "INVALID_STATUS"
      | "AMOUNT_MISMATCH"
      | "CURRENCY_MISMATCH"
      | "MISSING_PROVIDER_TXN"
      | "INVALID_AMOUNT";
  };

export function planCommissionWalletTopupConfirm(input: {
  currentStatus: CommissionTopupStatus | string;
  topupAmountMinor: number;
  topupCurrency: string;
  confirmedAmountMinor: number;
  confirmedCurrency: string;
  providerTransactionId: string | null | undefined;
  topupId: string;
}): CommissionWalletTopupConfirmPlan {
  const status = String(input.currentStatus).toUpperCase();
  if (status === COMMISSION_TOPUP_STATUS.SUCCEEDED) {
    return {
      ok: true,
      already_succeeded: true,
      entry_type: COMMISSION_WALLET_ENTRY_TYPE.TOP_UP_CREDIT,
      direction: "credit",
      amount_minor: Math.round(Number(input.topupAmountMinor) || 0),
      currency: String(input.topupCurrency).toUpperCase(),
      purchased_portion_minor: Math.round(Number(input.topupAmountMinor) || 0),
      promotional_portion_minor: 0,
      ledger_idempotency_key: buildCommissionWalletTopupCreditIdempotencyKey(input.topupId),
    };
  }
  if (
    !canTransitionCommissionTopupStatus(status, COMMISSION_TOPUP_STATUS.SUCCEEDED)
  ) {
    return {
      ok: false,
      error: `Cannot confirm top-up from status ${status}`,
      code: "INVALID_STATUS",
    };
  }
  const providerTxn = String(input.providerTransactionId ?? "").trim();
  if (!providerTxn) {
    return {
      ok: false,
      error: "provider_transaction_id required",
      code: "MISSING_PROVIDER_TXN",
    };
  }
  const topupAmount = Math.round(Number(input.topupAmountMinor) || 0);
  const confirmedAmount = Math.round(Number(input.confirmedAmountMinor) || 0);
  if (!Number.isFinite(confirmedAmount) || confirmedAmount <= 0) {
    return { ok: false, error: "confirmed amount must be > 0", code: "INVALID_AMOUNT" };
  }
  if (confirmedAmount !== topupAmount) {
    return {
      ok: false,
      error: "Confirmed amount does not match top-up amount",
      code: "AMOUNT_MISMATCH",
    };
  }
  const topupCurrency = String(input.topupCurrency ?? "").trim().toUpperCase();
  const confirmedCurrency = String(input.confirmedCurrency ?? "").trim().toUpperCase();
  if (!topupCurrency || topupCurrency !== confirmedCurrency) {
    return {
      ok: false,
      error: "Confirmed currency does not match top-up currency",
      code: "CURRENCY_MISMATCH",
    };
  }
  return {
    ok: true,
    already_succeeded: false,
    entry_type: COMMISSION_WALLET_ENTRY_TYPE.TOP_UP_CREDIT,
    direction: "credit",
    amount_minor: topupAmount,
    currency: topupCurrency,
    purchased_portion_minor: topupAmount,
    promotional_portion_minor: 0,
    ledger_idempotency_key: buildCommissionWalletTopupCreditIdempotencyKey(input.topupId),
  };
}

// ── Phase 5 — Welcome + promotional campaigns ──────────────────────────────

export const COMMISSION_WALLET_CAMPAIGN_TYPE = {
  WELCOME_CREDIT: "WELCOME_CREDIT",
  TOP_UP_PERCENT_BONUS: "TOP_UP_PERCENT_BONUS",
  FIXED_TOP_UP_BONUS: "FIXED_TOP_UP_BONUS",
  MANUAL_PROMOTIONAL_CREDIT: "MANUAL_PROMOTIONAL_CREDIT",
} as const;

export type CommissionWalletCampaignType =
  typeof COMMISSION_WALLET_CAMPAIGN_TYPE[keyof typeof COMMISSION_WALLET_CAMPAIGN_TYPE];

export const COMMISSION_WALLET_CLAIM_KIND = {
  WELCOME: "welcome",
  TOPUP_BONUS: "topup_bonus",
  MANUAL: "manual",
} as const;

export type CommissionWalletCampaignRow = {
  id?: string;
  campaign_type: CommissionWalletCampaignType | string;
  currency: string;
  active?: boolean | null;
  start_at?: string | null;
  end_at?: string | null;
  credit_amount_minor?: number | null;
  bonus_percent?: number | null;
  minimum_topup_amount_minor?: number | null;
  maximum_bonus_amount_minor?: number | null;
  maximum_claims?: number | null;
  maximum_claims_per_driver?: number | null;
};

export function isTopUpBonusCampaignType(type: string | null | undefined): boolean {
  const t = String(type ?? "").toUpperCase();
  return (
    t === COMMISSION_WALLET_CAMPAIGN_TYPE.TOP_UP_PERCENT_BONUS
    || t === COMMISSION_WALLET_CAMPAIGN_TYPE.FIXED_TOP_UP_BONUS
  );
}

export function isCampaignActiveInWindow(
  campaign: Pick<CommissionWalletCampaignRow, "active" | "start_at" | "end_at">,
  nowMs = Date.now(),
): boolean {
  if (campaign.active !== true) return false;
  if (campaign.start_at) {
    const start = Date.parse(String(campaign.start_at));
    if (Number.isFinite(start) && nowMs < start) return false;
  }
  if (campaign.end_at) {
    const end = Date.parse(String(campaign.end_at));
    if (Number.isFinite(end) && nowMs > end) return false;
  }
  return true;
}

export function buildCommissionWalletTopupBonusIdempotencyKey(
  topupId: string,
  campaignId: string,
): string {
  return `cw_topup_bonus_${String(topupId).trim()}_${String(campaignId).trim()}`.slice(0, 180);
}

export function buildCommissionWalletWelcomeIdempotencyKey(
  driverId: string,
  serviceAreaId: string,
): string {
  return `cw_welcome_${String(driverId).trim()}_${String(serviceAreaId).trim()}`.slice(0, 180);
}

export type CommissionWalletTopupBonusPlan =
  | {
    ok: true;
    amount_minor: number;
    entry_type: typeof COMMISSION_WALLET_ENTRY_TYPE.PROMOTIONAL_CREDIT;
    direction: "credit";
    campaign_type: string;
  }
  | {
    ok: false;
    error: string;
    code:
      | "NO_CAMPAIGN"
      | "INACTIVE"
      | "CURRENCY_MISMATCH"
      | "BELOW_MINIMUM"
      | "INVALID_AMOUNT"
      | "UNSUPPORTED_TYPE";
  };

export function planCommissionWalletTopupBonus(input: {
  campaign: CommissionWalletCampaignRow | null | undefined;
  topupAmountMinor: number;
  topupCurrency: string;
  nowMs?: number;
}): CommissionWalletTopupBonusPlan {
  if (!input.campaign) {
    return { ok: false, error: "No active top-up bonus campaign", code: "NO_CAMPAIGN" };
  }
  if (!isCampaignActiveInWindow(input.campaign, input.nowMs)) {
    return { ok: false, error: "Campaign is not active", code: "INACTIVE" };
  }
  const type = String(input.campaign.campaign_type ?? "").toUpperCase();
  if (!isTopUpBonusCampaignType(type)) {
    return { ok: false, error: "Campaign type is not a top-up bonus", code: "UNSUPPORTED_TYPE" };
  }
  const topupCurrency = String(input.topupCurrency ?? "").trim().toUpperCase();
  const campaignCurrency = String(input.campaign.currency ?? "").trim().toUpperCase();
  if (!topupCurrency || topupCurrency !== campaignCurrency) {
    return { ok: false, error: "Campaign currency mismatch", code: "CURRENCY_MISMATCH" };
  }
  const topupAmount = Math.round(Number(input.topupAmountMinor) || 0);
  if (!Number.isFinite(topupAmount) || topupAmount <= 0) {
    return { ok: false, error: "Invalid top-up amount", code: "INVALID_AMOUNT" };
  }
  const minTopup = Math.max(0, Math.round(Number(input.campaign.minimum_topup_amount_minor) || 0));
  if (topupAmount < minTopup) {
    return {
      ok: false,
      error: `Top-up below campaign minimum (${minTopup})`,
      code: "BELOW_MINIMUM",
    };
  }

  let bonus = 0;
  if (type === COMMISSION_WALLET_CAMPAIGN_TYPE.FIXED_TOP_UP_BONUS) {
    bonus = Math.round(Number(input.campaign.credit_amount_minor) || 0);
  } else {
    const percent = Number(input.campaign.bonus_percent);
    if (!Number.isFinite(percent) || percent <= 0) {
      return { ok: false, error: "Invalid bonus percent", code: "INVALID_AMOUNT" };
    }
    // bonus_percent is a percent value (e.g. 10 = 10%), not a fraction.
    bonus = Math.round(topupAmount * (percent / 100));
    const maxBonus = Math.round(Number(input.campaign.maximum_bonus_amount_minor) || 0);
    if (maxBonus > 0) bonus = Math.min(bonus, maxBonus);
  }

  if (!Number.isFinite(bonus) || bonus <= 0) {
    return { ok: false, error: "Bonus amount must be > 0", code: "INVALID_AMOUNT" };
  }

  return {
    ok: true,
    amount_minor: bonus,
    entry_type: COMMISSION_WALLET_ENTRY_TYPE.PROMOTIONAL_CREDIT,
    direction: "credit",
    campaign_type: type,
  };
}

export type WelcomeCreditAutoGrantPlan =
  | {
    ok: true;
    amount_minor: number;
    entry_type: typeof COMMISSION_WALLET_ENTRY_TYPE.WELCOME_CREDIT;
    ledger_idempotency_key: string;
  }
  | {
    ok: false;
    error: string;
    code: string;
  };

export function planWelcomeCreditAutoGrant(input: {
  walletEnabled: boolean;
  driverAssignedToServiceArea: boolean;
  welcomeCreditEnabled: boolean;
  welcomeCreditAmountMinor?: number | null;
  welcomeCreditMaxDrivers?: number | null;
  driverAlreadyHasWelcomeCredit: boolean;
  distinctWelcomeDriversCount: number;
  driverId: string;
  serviceAreaId: string;
}): WelcomeCreditAutoGrantPlan {
  if (!input.walletEnabled) {
    return {
      ok: false,
      error: "Commission Wallet is not enabled for this service area",
      code: "WALLET_DISABLED",
    };
  }
  const assignment = validateDriverCommissionWalletServiceAreaAssignment({
    driverAssignedToServiceArea: input.driverAssignedToServiceArea,
  });
  if (!assignment.ok) {
    return { ok: false, error: assignment.error, code: assignment.code };
  }

  const amount = Math.round(Number(input.welcomeCreditAmountMinor) || 0);
  if (amount <= 0) {
    return {
      ok: false,
      error: "Welcome credit amount is not configured",
      code: "WELCOME_CREDIT_AMOUNT_MISMATCH",
    };
  }

  const welcomeGate = validateAdminWelcomeCredit({
    creditKind: ADMIN_COMMISSION_CREDIT_KIND.WELCOME,
    welcomeCreditEnabled: input.welcomeCreditEnabled,
    welcomeCreditAmountMinor: amount,
    requestedAmountMinor: amount,
    driverAlreadyHasWelcomeCredit: input.driverAlreadyHasWelcomeCredit,
    distinctWelcomeDriversCount: input.distinctWelcomeDriversCount,
    welcomeCreditMaxDrivers: input.welcomeCreditMaxDrivers,
  });
  if (!welcomeGate.ok) {
    return { ok: false, error: welcomeGate.error, code: welcomeGate.code };
  }

  return {
    ok: true,
    amount_minor: amount,
    entry_type: COMMISSION_WALLET_ENTRY_TYPE.WELCOME_CREDIT,
    ledger_idempotency_key: buildCommissionWalletWelcomeIdempotencyKey(
      input.driverId,
      input.serviceAreaId,
    ),
  };
}

/** Manual promotional admin credit must attach an active MANUAL_PROMOTIONAL_CREDIT campaign. */
export function planManualPromotionalCampaignCredit(input: {
  walletEnabled: boolean;
  campaign: CommissionWalletCampaignRow | null | undefined;
  amountMinor: number;
  currency: string;
  nowMs?: number;
}): { ok: true; amount_minor: number } | { ok: false; error: string; code: string } {
  if (!input.walletEnabled) {
    return { ok: false, error: "Commission Wallet is not enabled", code: "WALLET_DISABLED" };
  }
  if (!input.campaign) {
    return {
      ok: false,
      error: "campaign_id required for promotional credit",
      code: "CAMPAIGN_REQUIRED",
    };
  }
  const type = String(input.campaign.campaign_type ?? "").toUpperCase();
  if (type !== COMMISSION_WALLET_CAMPAIGN_TYPE.MANUAL_PROMOTIONAL_CREDIT) {
    return {
      ok: false,
      error: "Campaign must be MANUAL_PROMOTIONAL_CREDIT",
      code: "CAMPAIGN_TYPE_MISMATCH",
    };
  }
  if (!isCampaignActiveInWindow(input.campaign, input.nowMs)) {
    return { ok: false, error: "Campaign is not active", code: "INACTIVE" };
  }
  const currency = String(input.currency ?? "").trim().toUpperCase();
  const campaignCurrency = String(input.campaign.currency ?? "").trim().toUpperCase();
  if (!currency || currency !== campaignCurrency) {
    return { ok: false, error: "Campaign currency mismatch", code: "CURRENCY_MISMATCH" };
  }
  const amount = Math.round(Number(input.amountMinor) || 0);
  if (amount <= 0) {
    return { ok: false, error: "amount must be > 0", code: "INVALID_AMOUNT" };
  }
  return { ok: true, amount_minor: amount };
}

/** Type-specific field validation for admin campaign create/update. */
export function validateCommissionWalletCampaignFields(input: {
  campaignType: string;
  creditAmountMinor?: number | null;
  bonusPercent?: number | null;
  minimumTopupAmountMinor?: number | null;
  maximumBonusAmountMinor?: number | null;
  startAt?: string | null;
  endAt?: string | null;
}): { ok: true } | { ok: false; error: string; code: string } {
  const type = String(input.campaignType ?? "").trim().toUpperCase();
  const validTypes = Object.values(COMMISSION_WALLET_CAMPAIGN_TYPE) as string[];
  if (!validTypes.includes(type)) {
    return { ok: false, error: "Invalid campaign_type", code: "INVALID_CAMPAIGN_TYPE" };
  }

  const startAt = input.startAt ? String(input.startAt) : null;
  const endAt = input.endAt ? String(input.endAt) : null;
  if (startAt && endAt) {
    const start = Date.parse(startAt);
    const end = Date.parse(endAt);
    if (Number.isFinite(start) && Number.isFinite(end) && end < start) {
      return { ok: false, error: "end_at must be >= start_at", code: "INVALID_WINDOW" };
    }
  }

  if (type === COMMISSION_WALLET_CAMPAIGN_TYPE.TOP_UP_PERCENT_BONUS) {
    const percent = Number(input.bonusPercent);
    if (!Number.isFinite(percent) || percent <= 0) {
      return { ok: false, error: "bonus_percent must be > 0", code: "INVALID_BONUS_PERCENT" };
    }
  }

  if (type === COMMISSION_WALLET_CAMPAIGN_TYPE.FIXED_TOP_UP_BONUS) {
    const credit = Math.round(Number(input.creditAmountMinor) || 0);
    if (credit <= 0) {
      return { ok: false, error: "credit_amount_minor must be > 0", code: "INVALID_AMOUNT" };
    }
  }

  if (
    type === COMMISSION_WALLET_CAMPAIGN_TYPE.WELCOME_CREDIT
    || type === COMMISSION_WALLET_CAMPAIGN_TYPE.MANUAL_PROMOTIONAL_CREDIT
  ) {
    // Welcome SA policy still owns amount at grant time; campaign credit is advisory/audit.
    // Manual promo amount is chosen at credit time — campaign may store a suggested amount (>= 0).
    const credit = Math.round(Number(input.creditAmountMinor) || 0);
    if (credit < 0) {
      return { ok: false, error: "credit_amount_minor invalid", code: "INVALID_AMOUNT" };
    }
  }

  const minTopup = Math.round(Number(input.minimumTopupAmountMinor) || 0);
  if (minTopup < 0) {
    return { ok: false, error: "minimum_topup_amount_minor invalid", code: "INVALID_AMOUNT" };
  }

  return { ok: true };
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

export function buildCommissionWalletReserveIdempotencyKey(
  driverId: string,
  tripId: string,
): string {
  return `cw_reserve_${String(driverId).trim()}_${String(tripId).trim()}`.slice(0, 180);
}

export function buildCommissionWalletReserveReleaseIdempotencyKey(
  driverId: string,
  tripId: string,
): string {
  return `cw_reserve_release_${String(driverId).trim()}_${String(tripId).trim()}`.slice(0, 180);
}

export type CommissionWalletDispatchEligibilityPlan =
  | {
    ok: true;
    eligible: true;
    required_reserve_minor: number;
    usable_commission_balance_minor: number;
  }
  | {
    ok: true;
    eligible: false;
    required_reserve_minor: number;
    usable_commission_balance_minor: number;
    code: "INSUFFICIENT_COMMISSION_WALLET_BALANCE";
    error: string;
  }
  | {
    ok: false;
    code: "GATE_OFF" | "INVALID_AMOUNT";
    error: string;
  };

/** Soft dispatch gate — skip when reserve workflow not enabled for the SA. */
export function planCommissionWalletDispatchEligibility(input: {
  gateApplies: boolean;
  estimatedFinalFareMinor: number;
  commissionRateBps: number;
  usableCommissionBalanceMinor: number;
  fixedPlatformChargeMinor?: number | null;
  includeFixedPlatformCharge?: boolean;
}): CommissionWalletDispatchEligibilityPlan {
  if (!input.gateApplies) {
    return { ok: false, code: "GATE_OFF", error: "Commission reserve dispatch gate is off" };
  }
  const required = requiredCommissionReserveMinor({
    estimatedFinalFareMinor: input.estimatedFinalFareMinor,
    commissionRateBps: input.commissionRateBps,
    fixedPlatformChargeMinor: input.fixedPlatformChargeMinor,
    includeFixedPlatformCharge: input.includeFixedPlatformCharge === true,
  });
  if (!Number.isFinite(required) || required < 0) {
    return { ok: false, code: "INVALID_AMOUNT", error: "Invalid required reserve" };
  }
  const usable = Math.max(0, Math.round(Number(input.usableCommissionBalanceMinor) || 0));
  if (usable < required) {
    return {
      ok: true,
      eligible: false,
      required_reserve_minor: required,
      usable_commission_balance_minor: usable,
      code: "INSUFFICIENT_COMMISSION_WALLET_BALANCE",
      error: `Usable balance ${usable} < required reserve ${required}`,
    };
  }
  return {
    ok: true,
    eligible: true,
    required_reserve_minor: required,
    usable_commission_balance_minor: usable,
  };
}

export type CommissionWalletReservePlan =
  | {
    ok: true;
    amount_minor: number;
    entry_type: typeof COMMISSION_WALLET_ENTRY_TYPE.COMMISSION_RESERVE;
    direction: "debit";
    ledger_idempotency_key: string;
  }
  | {
    ok: false;
    code:
      | "GATE_OFF"
      | "INSUFFICIENT_BALANCE"
      | "INVALID_AMOUNT"
      | "ALREADY_RESERVED";
    error: string;
  };

export function planCommissionWalletReserve(input: {
  gateApplies: boolean;
  estimatedFinalFareMinor: number;
  commissionRateBps: number;
  usableCommissionBalanceMinor: number;
  driverId: string;
  tripId: string;
  alreadyHasActiveReserve?: boolean;
  /** When active reserve exists, pass current reserved amount to allow adjust plans. */
  currentReserveAmountMinor?: number | null;
  fixedPlatformChargeMinor?: number | null;
  includeFixedPlatformCharge?: boolean;
}): CommissionWalletReservePlan {
  if (!input.gateApplies) {
    return { ok: false, code: "GATE_OFF", error: "Commission reserve gate is off" };
  }
  const amount = requiredCommissionReserveMinor({
    estimatedFinalFareMinor: input.estimatedFinalFareMinor,
    commissionRateBps: input.commissionRateBps,
    fixedPlatformChargeMinor: input.fixedPlatformChargeMinor,
    includeFixedPlatformCharge: input.includeFixedPlatformCharge === true,
  });
  if (input.alreadyHasActiveReserve) {
    // Legacy callers without current amount keep idempotent reject.
    if (input.currentReserveAmountMinor == null) {
      return { ok: false, code: "ALREADY_RESERVED", error: "Active reserve already exists" };
    }
    const current = Math.max(0, Math.round(Number(input.currentReserveAmountMinor) || 0));
    if (current === amount && amount > 0) {
      return { ok: false, code: "ALREADY_RESERVED", error: "Active reserve already exists" };
    }
    if (!Number.isFinite(amount) || amount < 0) {
      return { ok: false, code: "INVALID_AMOUNT", error: "Reserve amount must be >= 0" };
    }
    const delta = amount - current;
    const usable = Math.max(0, Math.round(Number(input.usableCommissionBalanceMinor) || 0));
    if (delta > 0 && usable < delta) {
      return {
        ok: false,
        code: "INSUFFICIENT_BALANCE",
        error: `Usable balance ${usable} < additional reserve ${delta}`,
      };
    }
    return {
      ok: true,
      amount_minor: amount,
      entry_type: COMMISSION_WALLET_ENTRY_TYPE.COMMISSION_RESERVE,
      direction: "debit",
      ledger_idempotency_key: buildCommissionWalletReserveIdempotencyKey(
        input.driverId,
        input.tripId,
      ),
    };
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, code: "INVALID_AMOUNT", error: "Reserve amount must be > 0" };
  }
  const usable = Math.max(0, Math.round(Number(input.usableCommissionBalanceMinor) || 0));
  if (usable < amount) {
    return {
      ok: false,
      code: "INSUFFICIENT_BALANCE",
      error: `Usable balance ${usable} < required reserve ${amount}`,
    };
  }
  return {
    ok: true,
    amount_minor: amount,
    entry_type: COMMISSION_WALLET_ENTRY_TYPE.COMMISSION_RESERVE,
    direction: "debit",
    ledger_idempotency_key: buildCommissionWalletReserveIdempotencyKey(
      input.driverId,
      input.tripId,
    ),
  };
}

export type CommissionWalletReserveReleasePlan =
  | {
    ok: true;
    amount_minor: number;
    entry_type: typeof COMMISSION_WALLET_ENTRY_TYPE.COMMISSION_RESERVE_RELEASE;
    direction: "credit";
    ledger_idempotency_key: string;
  }
  | {
    ok: false;
    code: "NO_ACTIVE_RESERVE" | "INVALID_AMOUNT" | "ALREADY_RELEASED";
    error: string;
  };

export function planCommissionWalletReserveRelease(input: {
  activeReserveAmountMinor: number | null | undefined;
  driverId: string;
  tripId: string;
  alreadyReleased?: boolean;
}): CommissionWalletReserveReleasePlan {
  if (input.alreadyReleased) {
    return { ok: false, code: "ALREADY_RELEASED", error: "Reserve already released" };
  }
  const amount = Math.round(Number(input.activeReserveAmountMinor) || 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, code: "NO_ACTIVE_RESERVE", error: "No active reserve to release" };
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

// ── Phase 7 — Completed-trip commission deduction + Finance reporting ────────

export function buildCommissionWalletDeductionIdempotencyKey(tripId: string): string {
  return `cw_deduction_${String(tripId).trim()}`.slice(0, 180);
}

export function buildCommissionWalletReserveConvertReleaseIdempotencyKey(
  reserveId: string,
): string {
  return `cw_reserve_convert_release_${String(reserveId).trim()}`.slice(0, 180);
}

/**
 * Trip uses Commission Wallet completion path when SA (or trip snapshot) has CW on.
 * Prefer explicit trip snapshot when both financial_model + commission_wallet_enabled are set.
 */
export function tripUsesCommissionWalletDeduction(input: {
  tripFinancialModel?: string | null;
  tripCommissionWalletEnabled?: boolean | null;
  serviceAreaConfig?: ServiceAreaCommissionWalletConfig | null;
}): boolean {
  const hasTripSnapshot =
    input.tripFinancialModel != null
    && input.tripFinancialModel !== ""
    && input.tripCommissionWalletEnabled != null;
  if (hasTripSnapshot) {
    return isCommissionWalletWorkflowEnabled({
      financial_model: input.tripFinancialModel,
      commission_wallet_enabled: input.tripCommissionWalletEnabled,
    });
  }
  return isCommissionWalletWorkflowEnabled(input.serviceAreaConfig);
}

/**
 * Exclude from UK PLATFORM_COLLECTED finance aggregates (settlement-summary / FR trip gross).
 * Trip snapshot financial_model is enough — CW revenue lives on COMMISSION_WALLET_DEDUCTION.
 */
export function excludeTripFromPlatformCollectedFinance(row: {
  financial_model?: string | null;
}): boolean {
  return (
    String(row.financial_model ?? "").toUpperCase()
    === SERVICE_AREA_FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET
  );
}

export type CommissionWalletDeductionPlan =
  | {
    ok: true;
    skipped: true;
    code: "GATE_OFF" | "ZERO_COMMISSION" | "ALREADY_DEDUCTED";
  }
  | {
    ok: true;
    skipped: false;
    commission_earned_minor: number;
    amount_minor: number;
    shortfall_minor: number;
    promotional_portion_minor: number;
    purchased_portion_minor: number;
    entry_type: typeof COMMISSION_WALLET_ENTRY_TYPE.COMMISSION_DEDUCTION;
    direction: "debit";
    ledger_idempotency_key: string;
    convert_active_reserve: boolean;
    revenue_source: typeof REVENUE_SOURCE_COMMISSION_WALLET_DEDUCTION;
  }
  | {
    ok: false;
    code: "INVALID_AMOUNT";
    error: string;
  };

/**
 * Plan completion deduction: promo-first consumption, one row per trip,
 * optional active-reserve convert (release ledger + converted_to_deduction status).
 * amount_minor = actually deducted (may be < earned when shortfall).
 */
export function planCommissionWalletDeduction(input: {
  gateApplies: boolean;
  commissionableFareMinor: number;
  commissionRateBps: number;
  /** When set, used instead of recomputing fare × bps (must match settlement SSOT). */
  commissionEarnedMinor?: number | null;
  promotionalBalanceMinor: number;
  purchasedBalanceMinor: number;
  /** Usable after releasing any active reserve for this trip (purchased+promo−remaining reserved). */
  usableBalanceMinorAfterReserveRelease: number;
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
  const earnedExplicit = input.commissionEarnedMinor;
  const earned = earnedExplicit != null && Number.isFinite(Number(earnedExplicit))
    ? Math.max(0, Math.round(Number(earnedExplicit)))
    : onecabCommissionDeductionMinor({
      commissionableFareMinor: input.commissionableFareMinor,
      commissionRateBps: input.commissionRateBps,
    });
  if (!Number.isFinite(earned) || earned < 0) {
    return { ok: false, code: "INVALID_AMOUNT", error: "Invalid commission amount" };
  }
  if (earned === 0) {
    return { ok: true, skipped: true, code: "ZERO_COMMISSION" };
  }

  const usable = Math.max(0, Math.round(Number(input.usableBalanceMinorAfterReserveRelease) || 0));
  const amount = Math.min(earned, usable);
  const shortfall = Math.max(0, earned - amount);
  const split = splitCommissionConsumption({
    deductionMinor: amount,
    promotionalBalanceMinor: input.promotionalBalanceMinor,
    purchasedBalanceMinor: input.purchasedBalanceMinor,
  });

  return {
    ok: true,
    skipped: false,
    commission_earned_minor: earned,
    amount_minor: amount,
    shortfall_minor: shortfall,
    promotional_portion_minor: split.promotional_portion_minor,
    purchased_portion_minor: split.purchased_portion_minor,
    entry_type: COMMISSION_WALLET_ENTRY_TYPE.COMMISSION_DEDUCTION,
    direction: "debit",
    ledger_idempotency_key: buildCommissionWalletDeductionIdempotencyKey(input.tripId),
    convert_active_reserve: input.hasActiveReserve === true,
    revenue_source: REVENUE_SOURCE_COMMISSION_WALLET_DEDUCTION,
  };
}

export type CommissionWalletFinanceReportSlice = {
  entry_type: string;
  amount_minor: number | null;
  direction?: string | null;
  metadata?: {
    commission_earned_minor?: number | null;
    shortfall_minor?: number | null;
    provider_fee_minor?: number | null;
  } | Record<string, unknown> | null;
};

/**
 * Finance classification COMMISSION_WALLET_DEDUCTION — never treat customer fare as ONECAB revenue.
 * PLATFORM_COLLECTED reporting must stay on driver_wallet_ledger PLATFORM_COMMISSION.
 */
export function aggregateCommissionWalletFinanceReport(
  ledgerRows: CommissionWalletFinanceReportSlice[],
  opts?: {
    completedDriverCollectedTrips?: number;
    totalCustomerFaresReportedMinor?: number;
    walletLiabilitiesMinor?: number;
    /** Provider top-up / PSP fees when known (else 0 until Phase 4 fee ledger exists). */
    providerTransactionFeesMinor?: number;
  },
): {
  revenue_source: typeof REVENUE_SOURCE_COMMISSION_WALLET_DEDUCTION;
  completed_driver_collected_trips: number;
  total_customer_fares_reported_minor: number;
  onecab_customer_collection_minor: 0;
  total_onecab_commission_earned_minor: number;
  commission_actually_deducted_minor: number;
  commission_shortfall_minor: number;
  onecab_revenue_minor: number;
  driver_payout_liability_minor: 0;
  outstanding_reserves_minor: number;
  provider_topups_minor: number;
  admin_credits_minor: number;
  promotional_credits_minor: number;
  campaign_cost_minor: number;
  topup_reversals_minor: number;
  provider_transaction_fees_minor: number;
  commission_wallet_liabilities_minor: number;
} {
  let deducted = 0;
  let earnedFromMeta = 0;
  let shortfallFromMeta = 0;
  let hasEarnedMeta = false;
  let reserves = 0;
  let reserveReleases = 0;
  let providerTopups = 0;
  let adminCredits = 0;
  let promotionalCredits = 0;
  let welcomeCredits = 0;
  let topupReversals = 0;
  let providerFeesFromMeta = 0;

  for (const row of ledgerRows) {
    const amount = Math.max(0, Math.round(Number(row.amount_minor) || 0));
    const type = String(row.entry_type ?? "").toUpperCase();
    const meta = (row.metadata && typeof row.metadata === "object")
      ? row.metadata as Record<string, unknown>
      : null;

    if (type === COMMISSION_WALLET_ENTRY_TYPE.COMMISSION_DEDUCTION) {
      deducted += amount;
      if (meta) {
        const earned = Math.round(Number(meta.commission_earned_minor) || 0);
        const shortfall = Math.round(Number(meta.shortfall_minor) || 0);
        if (earned > 0 || shortfall > 0 || meta.commission_earned_minor != null) {
          hasEarnedMeta = true;
          earnedFromMeta += Math.max(0, earned || amount);
          shortfallFromMeta += Math.max(0, shortfall);
        }
      }
    } else if (type === COMMISSION_WALLET_ENTRY_TYPE.COMMISSION_RESERVE) {
      reserves += amount;
    } else if (type === COMMISSION_WALLET_ENTRY_TYPE.COMMISSION_RESERVE_RELEASE) {
      reserveReleases += amount;
    } else if (type === COMMISSION_WALLET_ENTRY_TYPE.TOP_UP_CREDIT) {
      providerTopups += amount;
      if (meta) {
        providerFeesFromMeta += Math.max(0, Math.round(Number(meta.provider_fee_minor) || 0));
      }
    } else if (type === COMMISSION_WALLET_ENTRY_TYPE.ADMIN_CREDIT) {
      adminCredits += amount;
    } else if (type === COMMISSION_WALLET_ENTRY_TYPE.PROMOTIONAL_CREDIT) {
      promotionalCredits += amount;
    } else if (type === COMMISSION_WALLET_ENTRY_TYPE.WELCOME_CREDIT) {
      welcomeCredits += amount;
    } else if (type === COMMISSION_WALLET_ENTRY_TYPE.TOP_UP_REVERSAL) {
      topupReversals += amount;
    }
  }

  const campaignCost = promotionalCredits + welcomeCredits;
  const outstandingReserves = Math.max(0, reserves - reserveReleases);
  const earned = hasEarnedMeta ? earnedFromMeta : deducted;
  const shortfall = hasEarnedMeta
    ? shortfallFromMeta
    : Math.max(0, earned - deducted);
  const providerFees = Math.max(
    0,
    Math.round(Number(opts?.providerTransactionFeesMinor) || providerFeesFromMeta || 0),
  );

  return {
    revenue_source: REVENUE_SOURCE_COMMISSION_WALLET_DEDUCTION,
    completed_driver_collected_trips: Math.max(
      0,
      Math.round(Number(opts?.completedDriverCollectedTrips) || 0),
    ),
    total_customer_fares_reported_minor: Math.max(
      0,
      Math.round(Number(opts?.totalCustomerFaresReportedMinor) || 0),
    ),
    onecab_customer_collection_minor: 0,
    total_onecab_commission_earned_minor: earned,
    commission_actually_deducted_minor: deducted,
    commission_shortfall_minor: shortfall,
    onecab_revenue_minor: deducted,
    driver_payout_liability_minor: 0,
    outstanding_reserves_minor: outstandingReserves,
    provider_topups_minor: providerTopups,
    admin_credits_minor: adminCredits,
    promotional_credits_minor: promotionalCredits + welcomeCredits,
    campaign_cost_minor: campaignCost,
    topup_reversals_minor: topupReversals,
    provider_transaction_fees_minor: providerFees,
    commission_wallet_liabilities_minor: Math.max(
      0,
      Math.round(Number(opts?.walletLiabilitiesMinor) || 0),
    ),
  };
}

/**
 * Phase 8 — skip Stripe/Revolut preauth when CW workflow uses driver-collected upfront.
 * UK PLATFORM_COLLECTED must keep digital authorization.
 */
export function shouldSkipPlatformPreauthForCommissionWallet(
  config: ServiceAreaCommissionWalletConfig | null | undefined,
): boolean {
  if (!isCommissionWalletWorkflowEnabled(config)) return false;
  return (
    String(config?.customer_payment_policy ?? "").toUpperCase()
    === CUSTOMER_PAYMENT_POLICY.DRIVER_COLLECTS_UPFRONT
  );
}

/**
 * Phase 8 — trip payment columns for DRIVER_COLLECTS_UPFRONT (cash to driver).
 * Omit payment_reauth_status (CHECK allows only pending|success|failed).
 */
export function tripCashUpfrontPaymentFields(): {
  payment_method: "cash";
  payment_type: "cash";
  payment_status: "driver_collects_upfront";
  payment_coverage_status: "not_required";
  payment_state: "booking_created";
  payment_deferred: false;
  deferred_payment_method_id: null;
  original_payment_method: "cash";
} {
  return {
    payment_method: "cash",
    payment_type: "cash",
    payment_status: "driver_collects_upfront",
    payment_coverage_status: "not_required",
    payment_state: "booking_created",
    payment_deferred: false,
    deferred_payment_method_id: null,
    original_payment_method: "cash",
  };
}

/** Fields to persist on trips at booking create (Phase 8 writers). */
export function tripInsertFieldsFromFinancialModelSnapshot(
  snap: TripFinancialModelSnapshot,
): {
  financial_model: ServiceAreaFinancialModel;
  payment_collection_model: CustomerPaymentPolicy;
  commission_wallet_enabled: boolean;
  snapshotted_commission_rate_bps: number;
  snapshotted_commission_currency: string;
} {
  return {
    financial_model: snap.financial_model,
    payment_collection_model: snap.payment_collection_model,
    commission_wallet_enabled: snap.commission_wallet_enabled,
    snapshotted_commission_rate_bps: snap.commission_rate_bps,
    snapshotted_commission_currency: snap.currency,
  };
}

/**
 * Phase 8 — single African pilot Service Area until reconciliation unlocks multi-SA.
 * Isolation remains SA-flag based; this constant documents the live pilot identity only.
 */
export const COMMISSION_WALLET_PHASE8_PILOT = {
  service_area_id: "29259edf-80eb-4c08-9089-352b8a305b81",
  service_area_name: "Banadir",
  region_name: "Mogadishu",
  currency: "USD",
  topup_provider: "waafi_pay",
} as const;

export type CommissionWalletRolloutState = {
  pilot_service_area_id: string | null | undefined;
  multi_sa_unlocked: boolean | null | undefined;
};

export type CommissionWalletSaEnablementPlan =
  | { ok: true }
  | {
    ok: false;
    code: "PILOT_LOCK" | "ROLLOUT_MISSING";
    error: string;
  };

/**
 * Admin enable gate for Phase 8. Disabling is always allowed.
 * When multi_sa_unlocked is false, only the pilot SA may turn commission_wallet_enabled on.
 */
export function planCommissionWalletServiceAreaEnablement(input: {
  serviceAreaId: string;
  enabling: boolean;
  rollout: CommissionWalletRolloutState | null | undefined;
}): CommissionWalletSaEnablementPlan {
  if (!input.enabling) return { ok: true };
  if (!input.rollout) {
    return {
      ok: false,
      code: "ROLLOUT_MISSING",
      error:
        "Commission Wallet rollout lock is missing. Refuse enable until Phase 8 rollout row exists.",
    };
  }
  if (input.rollout.multi_sa_unlocked === true) return { ok: true };
  const pilotId = String(input.rollout.pilot_service_area_id ?? "").trim();
  if (!pilotId) {
    return {
      ok: false,
      code: "ROLLOUT_MISSING",
      error: "Commission Wallet pilot service area is not configured.",
    };
  }
  if (String(input.serviceAreaId) === pilotId) return { ok: true };
  return {
    ok: false,
    code: "PILOT_LOCK",
    error:
      `Phase 8 pilot lock: only ${COMMISSION_WALLET_PHASE8_PILOT.service_area_name} `
      + "may enable Commission Wallet until reconciliation unlocks multi-SA.",
  };
}

/** Non-financial CW account profile — balances stay ledger-derived. */
export const COMMISSION_WALLET_ACCOUNT_SOURCE = {
  BACKFILL: "backfill",
  AUTO_ASSIGNMENT: "auto_assignment",
  SA_MOVE: "sa_move",
  ADMIN_REPAIR: "admin_repair",
} as const;

export type CommissionWalletAccountSource =
  typeof COMMISSION_WALLET_ACCOUNT_SOURCE[keyof typeof COMMISSION_WALLET_ACCOUNT_SOURCE];

export const COMMISSION_WALLET_SETUP_ERROR = {
  MISSING_ACCOUNT: "MISSING_ACCOUNT",
  CURRENCY_MISMATCH: "CURRENCY_MISMATCH",
  REGION_MISMATCH: "REGION_MISMATCH",
  DRIVER_NOT_ASSIGNED: "DRIVER_NOT_ASSIGNED",
} as const;

export type CommissionWalletSetupErrorCode =
  typeof COMMISSION_WALLET_SETUP_ERROR[keyof typeof COMMISSION_WALLET_SETUP_ERROR];

/**
 * Zero-balance profile is never offer-eligible.
 * Admin list uses minimum balance as the standing gate (trip reserve is per-offer).
 */
export function isCommissionWalletOfferEligibleFromBalances(input: {
  usableCommissionBalanceMinor: number;
  minimumBalanceMinor: number;
}): boolean {
  const usable = Math.max(0, Math.round(Number(input.usableCommissionBalanceMinor) || 0));
  const min = Math.max(0, Math.round(Number(input.minimumBalanceMinor) || 0));
  return usable >= min && usable > 0;
}

export function buildCommissionWalletDriverRosterRow(input: {
  driverId: string;
  driverCode?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  driverStatus?: string | null;
  approvalStatus?: string | null;
  serviceAreaId: string;
  regionId?: string | null;
  currency: string;
  minimumBalanceMinor: number;
  account: {
    id: string;
    currency: string;
    region_id: string;
    source?: string | null;
  } | null;
  balances?: {
    usable_commission_balance_minor?: number;
    purchased_balance_minor?: number;
    promotional_balance_minor?: number;
    reserved_balance_minor?: number;
  } | null;
  welcomeCreditGranted?: boolean;
  testModeActive?: boolean;
}): {
  driver_id: string;
  driver_code: string | null;
  driver_name: string;
  phone: string | null;
  driver_status: string | null;
  approval_status: string | null;
  service_area_id: string;
  region_id: string | null;
  currency: string;
  profile_status: "present" | "missing";
  account_id: string | null;
  account_source: string | null;
  usable_commission_balance_minor: number;
  purchased_balance_minor: number;
  promotional_balance_minor: number;
  reserved_balance_minor: number;
  below_minimum: boolean;
  offer_eligible: boolean;
  welcome_credit_granted: boolean;
  test_mode_active: boolean;
  setup_error: CommissionWalletSetupErrorCode | null;
  setup_error_reason: string | null;
} {
  const bal = input.balances ?? {};
  const usable = Math.max(0, Math.round(Number(bal.usable_commission_balance_minor) || 0));
  const purchased = Math.max(0, Math.round(Number(bal.purchased_balance_minor) || 0));
  const promotional = Math.max(0, Math.round(Number(bal.promotional_balance_minor) || 0));
  const reserved = Math.max(0, Math.round(Number(bal.reserved_balance_minor) || 0));
  const min = Math.max(0, Math.round(Number(input.minimumBalanceMinor) || 0));
  const name = `${input.firstName ?? ""} ${input.lastName ?? ""}`.trim();

  let setupError: CommissionWalletSetupErrorCode | null = null;
  let setupReason: string | null = null;
  if (!input.account) {
    setupError = COMMISSION_WALLET_SETUP_ERROR.MISSING_ACCOUNT;
    setupReason = "Commission Wallet profile missing after backfill/assignment";
  } else if (
    String(input.account.currency ?? "").toUpperCase()
    !== String(input.currency ?? "").toUpperCase()
  ) {
    setupError = COMMISSION_WALLET_SETUP_ERROR.CURRENCY_MISMATCH;
    setupReason = `Account currency ${input.account.currency} does not match SA ${input.currency}`;
  } else if (
    input.regionId
    && String(input.account.region_id) !== String(input.regionId)
  ) {
    setupError = COMMISSION_WALLET_SETUP_ERROR.REGION_MISMATCH;
    setupReason = "Account region_id does not match Service Area region";
  }

  return {
    driver_id: input.driverId,
    driver_code: input.driverCode ?? null,
    driver_name: name || (input.driverCode ?? input.driverId.slice(0, 8)),
    phone: input.phone ?? null,
    driver_status: input.driverStatus ?? null,
    approval_status: input.approvalStatus ?? null,
    service_area_id: input.serviceAreaId,
    region_id: input.regionId ?? null,
    currency: String(input.currency ?? "").toUpperCase(),
    profile_status: input.account ? "present" : "missing",
    account_id: input.account?.id ?? null,
    account_source: input.account?.source ?? null,
    usable_commission_balance_minor: usable,
    purchased_balance_minor: purchased,
    promotional_balance_minor: promotional,
    reserved_balance_minor: reserved,
    below_minimum: usable < min,
    offer_eligible: isCommissionWalletOfferEligibleFromBalances({
      usableCommissionBalanceMinor: usable,
      minimumBalanceMinor: min,
    }),
    welcome_credit_granted: input.welcomeCreditGranted === true,
    test_mode_active: input.testModeActive === true,
    setup_error: setupError,
    setup_error_reason: setupReason,
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
