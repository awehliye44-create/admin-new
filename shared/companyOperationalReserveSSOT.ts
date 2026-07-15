/**
 * Slice 10 — Operational / Refund Reserve SSOT + final company funds gate.
 *
 * Configuration never moves money. Client must not invent reserve amounts —
 * only ACTIVE backend policy unlocks final_company_available.
 *
 * Until ACTIVE policy: reserve NOT_CONFIGURED, final Available UNAVAILABLE,
 * company transfer execution BLOCKED. Never fall back to zero reserve silently.
 */

export const SLICE10 = 10 as const;

export const OPERATIONAL_RESERVE_SETTING_KEY_LEGACY =
  "company_operational_refund_reserve" as const;

export const RESERVE_MODE = {
  FIXED_AMOUNT: "FIXED_AMOUNT",
  PERCENTAGE: "PERCENTAGE",
} as const;

export type ReserveMode = (typeof RESERVE_MODE)[keyof typeof RESERVE_MODE];

export const RESERVE_POLICY_STATUS = {
  DRAFT: "DRAFT",
  ACTIVE: "ACTIVE",
  DISABLED: "DISABLED",
} as const;

export type ReservePolicyStatus =
  (typeof RESERVE_POLICY_STATUS)[keyof typeof RESERVE_POLICY_STATUS];

export const OPERATIONAL_RESERVE_ERROR = {
  NOT_CONFIGURED: "OPERATIONAL_RESERVE_NOT_CONFIGURED",
  INVALID: "OPERATIONAL_RESERVE_INVALID",
  INACTIVE: "OPERATIONAL_RESERVE_INACTIVE",
  STALE: "OPERATIONAL_RESERVE_STALE",
  CURRENCY_MISMATCH: "OPERATIONAL_RESERVE_CURRENCY_MISMATCH",
  SERVICE_AREA_MISMATCH: "OPERATIONAL_RESERVE_SERVICE_AREA_MISMATCH",
  QUERY_FAILED: "OPERATIONAL_RESERVE_QUERY_FAILED",
  CLASSIFIED_CASH_UNAVAILABLE: "CLASSIFIED_COMPANY_CASH_UNAVAILABLE",
  TRANSFER_BLOCKED: "COMPANY_TRANSFER_BLOCKED_RESERVE_GATE",
} as const;

export type OperationalReserveErrorCode =
  (typeof OPERATIONAL_RESERVE_ERROR)[keyof typeof OPERATIONAL_RESERVE_ERROR];

/** Proven money state — do not mutate (Slice 7–9 PASS). */
export const SLICE10_PROOF = {
  SOURCE_PENCE: 1526,
  LIABILITY_PENCE: 1001,
  RESERVED_PENCE: 1001,
  BEFORE_RESERVE_PENCE: 525,
  NET_COMMISSION_PENCE: 172,
  UNCLASSIFIED_PENCE: 353,
  APPROVED_PAYABLES_PENCE: 0,
} as const;

export type CompanyOperationalReservePolicy = {
  id?: string | null;
  service_area_id: string | null;
  currency: string;
  reserve_mode: ReserveMode;
  /** FIXED_AMOUNT: pence held back. */
  reserve_amount_pence: number | null;
  /** PERCENTAGE: basis points of eligible_company_cash (10000 = 100%). */
  reserve_percentage_bps: number | null;
  minimum_reserve_pence: number | null;
  effective_from: string | null;
  effective_to: string | null;
  status: ReservePolicyStatus;
  created_by?: string | null;
  approved_by?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  activated_at?: string | null;
  disabled_at?: string | null;
  audit_note?: string | null;
};

export type ResolvedOperationalReserve = {
  status: "ACTIVE" | "NOT_CONFIGURED" | "UNAVAILABLE";
  amount_pence: number | null;
  policy: CompanyOperationalReservePolicy | null;
  reason_code: OperationalReserveErrorCode | null;
};

/**
 * eligible_company_cash = max(0, source − protected_liabilities − approved_payables)
 * (customer_refund_reserved included in protected sum when present)
 */
export function computeEligibleCompanyCashPence(args: {
  provider_available_balance_pence: number | null;
  driver_liability_pence?: number | null;
  customer_refund_reserved_pence?: number | null;
  approved_company_payables_pence?: number | null;
}): number | null {
  if (args.provider_available_balance_pence == null) return null;
  if (args.driver_liability_pence === null) return null;
  const protectedSum = Math.max(0, Number(args.driver_liability_pence ?? 0))
    + Math.max(0, Number(args.customer_refund_reserved_pence ?? 0))
    + Math.max(0, Number(args.approved_company_payables_pence ?? 0));
  return Math.max(0, args.provider_available_balance_pence - protectedSum);
}

/**
 * classified_company_cash = recognised_net_commission + other explicitly classified funding.
 * UNATTRIBUTED / RECONCILIATION_REQUIRED never included.
 */
export function computeClassifiedCompanyCashPence(args: {
  recognised_net_commission_pence: number | null | undefined;
  other_classified_funding_pence?: number | null;
}): number | null {
  if (args.recognised_net_commission_pence == null) return null;
  return Math.max(0, Math.round(Number(args.recognised_net_commission_pence)))
    + Math.max(0, Math.round(Number(args.other_classified_funding_pence ?? 0)));
}

/** transferable_base = min(eligible_company_cash, classified_company_cash) */
export function computeTransferableBasePence(args: {
  eligible_company_cash_pence: number | null;
  classified_company_cash_pence: number | null;
}): number | null {
  if (args.eligible_company_cash_pence == null) return null;
  if (args.classified_company_cash_pence == null) return null;
  return Math.min(
    Math.max(0, Math.round(args.eligible_company_cash_pence)),
    Math.max(0, Math.round(args.classified_company_cash_pence)),
  );
}

/**
 * FIXED: reserve = fixed amount
 * PERCENTAGE: reserve = max(minimum, round(eligible * bps / 10000))
 */
export function computeOperationalReserveAmountPence(args: {
  policy: Pick<
    CompanyOperationalReservePolicy,
    "reserve_mode" | "reserve_amount_pence" | "reserve_percentage_bps" | "minimum_reserve_pence"
  >;
  eligible_company_cash_pence: number | null;
}): number | null {
  const mode = String(args.policy.reserve_mode ?? "").toUpperCase();
  if (mode === RESERVE_MODE.FIXED_AMOUNT) {
    const n = Number(args.policy.reserve_amount_pence);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.round(n);
  }
  if (mode === RESERVE_MODE.PERCENTAGE) {
    if (args.eligible_company_cash_pence == null) return null;
    const bps = Number(args.policy.reserve_percentage_bps);
    if (!Number.isFinite(bps) || bps < 0 || bps > 100_000) return null;
    const raw = Math.round(
      (Math.max(0, args.eligible_company_cash_pence) * bps) / 10_000,
    );
    const minimum = Math.max(0, Math.round(Number(args.policy.minimum_reserve_pence ?? 0)));
    return Math.max(minimum, raw);
  }
  return null;
}

/**
 * final_company_available = max(0, transferable_base − operational_reserve)
 *
 * approved_payables are deducted once inside eligible_company_cash (not again).
 * Fail-closed when reserve or classified inputs missing.
 */
export function computeFinalCompanyAvailablePence(args: {
  eligible_company_cash_pence: number | null;
  classified_company_cash_pence: number | null;
  operational_reserve_pence: number | null | undefined;
}): number | null {
  if (args.operational_reserve_pence === null || args.operational_reserve_pence === undefined) {
    return null;
  }
  const base = computeTransferableBasePence({
    eligible_company_cash_pence: args.eligible_company_cash_pence,
    classified_company_cash_pence: args.classified_company_cash_pence,
  });
  if (base == null) return null;
  return Math.max(0, base - Math.max(0, Math.round(Number(args.operational_reserve_pence))));
}

export function parseReserveMode(raw: unknown): ReserveMode | null {
  const m = String(raw ?? "").trim().toUpperCase();
  if (m === RESERVE_MODE.FIXED_AMOUNT || m === "FIXED") return RESERVE_MODE.FIXED_AMOUNT;
  if (m === RESERVE_MODE.PERCENTAGE || m === "PERCENT" || m === "PCT") {
    return RESERVE_MODE.PERCENTAGE;
  }
  return null;
}

export function parseReservePolicyStatus(raw: unknown): ReservePolicyStatus | null {
  const s = String(raw ?? "").trim().toUpperCase();
  if (s === RESERVE_POLICY_STATUS.DRAFT) return RESERVE_POLICY_STATUS.DRAFT;
  if (s === RESERVE_POLICY_STATUS.ACTIVE) return RESERVE_POLICY_STATUS.ACTIVE;
  if (s === RESERVE_POLICY_STATUS.DISABLED) return RESERVE_POLICY_STATUS.DISABLED;
  return null;
}

export function validateReservePolicyDraft(args: {
  reserve_mode: unknown;
  reserve_amount_pence?: unknown;
  reserve_percentage_bps?: unknown;
  minimum_reserve_pence?: unknown;
  currency?: unknown;
}): { ok: true } | { ok: false; reason_code: OperationalReserveErrorCode; message: string } {
  const mode = parseReserveMode(args.reserve_mode);
  if (!mode) {
    return {
      ok: false,
      reason_code: OPERATIONAL_RESERVE_ERROR.INVALID,
      message: "reserve_mode must be FIXED_AMOUNT or PERCENTAGE",
    };
  }
  const currency = String(args.currency ?? "GBP").trim().toUpperCase();
  if (!currency || currency.length !== 3) {
    return {
      ok: false,
      reason_code: OPERATIONAL_RESERVE_ERROR.INVALID,
      message: "currency must be a 3-letter ISO code",
    };
  }
  if (mode === RESERVE_MODE.FIXED_AMOUNT) {
    const n = Number(args.reserve_amount_pence);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      return {
        ok: false,
        reason_code: OPERATIONAL_RESERVE_ERROR.INVALID,
        message: "FIXED_AMOUNT requires non-negative integer reserve_amount_pence",
      };
    }
  } else {
    const bps = Number(args.reserve_percentage_bps);
    if (!Number.isFinite(bps) || bps < 0 || bps > 100_000 || !Number.isInteger(bps)) {
      return {
        ok: false,
        reason_code: OPERATIONAL_RESERVE_ERROR.INVALID,
        message: "PERCENTAGE requires integer reserve_percentage_bps in 0..100000",
      };
    }
    const min = args.minimum_reserve_pence == null
      ? 0
      : Number(args.minimum_reserve_pence);
    if (!Number.isFinite(min) || min < 0 || !Number.isInteger(min)) {
      return {
        ok: false,
        reason_code: OPERATIONAL_RESERVE_ERROR.INVALID,
        message: "minimum_reserve_pence must be a non-negative integer",
      };
    }
  }
  return { ok: true };
}

/**
 * Gate an ACTIVE policy for the requested currency / service area / as-of time.
 * DRAFT and DISABLED never unlock final funds.
 */
export function evaluateActiveReservePolicy(args: {
  policy: CompanyOperationalReservePolicy | null | undefined;
  currency: string;
  service_area_id?: string | null;
  as_of?: Date | string | null;
}): ResolvedOperationalReserve {
  if (!args.policy) {
    return {
      status: "NOT_CONFIGURED",
      amount_pence: null,
      policy: null,
      reason_code: OPERATIONAL_RESERVE_ERROR.NOT_CONFIGURED,
    };
  }
  const status = parseReservePolicyStatus(args.policy.status);
  if (status !== RESERVE_POLICY_STATUS.ACTIVE) {
    return {
      status: status === RESERVE_POLICY_STATUS.DRAFT || status === RESERVE_POLICY_STATUS.DISABLED
        ? "NOT_CONFIGURED"
        : "UNAVAILABLE",
      amount_pence: null,
      policy: args.policy,
      reason_code: status == null
        ? OPERATIONAL_RESERVE_ERROR.INVALID
        : OPERATIONAL_RESERVE_ERROR.INACTIVE,
    };
  }

  const wantCcy = String(args.currency ?? "GBP").trim().toUpperCase();
  const gotCcy = String(args.policy.currency ?? "").trim().toUpperCase();
  if (!gotCcy || gotCcy !== wantCcy) {
    return {
      status: "UNAVAILABLE",
      amount_pence: null,
      policy: args.policy,
      reason_code: OPERATIONAL_RESERVE_ERROR.CURRENCY_MISMATCH,
    };
  }

  const wantSa = args.service_area_id == null || args.service_area_id === ""
    ? null
    : String(args.service_area_id);
  const gotSa = args.policy.service_area_id == null || args.policy.service_area_id === ""
    ? null
    : String(args.policy.service_area_id);
  if (wantSa != null && gotSa != null && wantSa !== gotSa) {
    return {
      status: "UNAVAILABLE",
      amount_pence: null,
      policy: args.policy,
      reason_code: OPERATIONAL_RESERVE_ERROR.SERVICE_AREA_MISMATCH,
    };
  }

  const asOf = args.as_of == null
    ? new Date()
    : typeof args.as_of === "string"
      ? new Date(args.as_of)
      : args.as_of;
  const asOfMs = asOf.getTime();
  if (!Number.isFinite(asOfMs)) {
    return {
      status: "UNAVAILABLE",
      amount_pence: null,
      policy: args.policy,
      reason_code: OPERATIONAL_RESERVE_ERROR.INVALID,
    };
  }
  if (args.policy.effective_from) {
    const from = Date.parse(String(args.policy.effective_from));
    if (Number.isFinite(from) && asOfMs < from) {
      return {
        status: "UNAVAILABLE",
        amount_pence: null,
        policy: args.policy,
        reason_code: OPERATIONAL_RESERVE_ERROR.STALE,
      };
    }
  }
  if (args.policy.effective_to) {
    const to = Date.parse(String(args.policy.effective_to));
    if (Number.isFinite(to) && asOfMs > to) {
      return {
        status: "UNAVAILABLE",
        amount_pence: null,
        policy: args.policy,
        reason_code: OPERATIONAL_RESERVE_ERROR.STALE,
      };
    }
  }

  // Amount resolved later with eligible cash (PERCENTAGE). Presence of ACTIVE
  // policy is enough here — amount_pence left null until formula pass.
  return {
    status: "ACTIVE",
    amount_pence: null,
    policy: args.policy,
    reason_code: null,
  };
}

export function resolveOperationalReserveAmount(args: {
  policy: CompanyOperationalReservePolicy | null | undefined;
  currency: string;
  service_area_id?: string | null;
  eligible_company_cash_pence: number | null;
  as_of?: Date | string | null;
}): ResolvedOperationalReserve {
  const gated = evaluateActiveReservePolicy({
    policy: args.policy,
    currency: args.currency,
    service_area_id: args.service_area_id,
    as_of: args.as_of,
  });
  if (gated.status !== "ACTIVE" || !gated.policy) return gated;
  const amount = computeOperationalReserveAmountPence({
    policy: gated.policy,
    eligible_company_cash_pence: args.eligible_company_cash_pence,
  });
  if (amount == null) {
    return {
      status: "UNAVAILABLE",
      amount_pence: null,
      policy: gated.policy,
      reason_code: OPERATIONAL_RESERVE_ERROR.INVALID,
    };
  }
  return {
    status: "ACTIVE",
    amount_pence: amount,
    policy: gated.policy,
    reason_code: null,
  };
}

/** Explicit company-transfer gate reasons (never source / protected / gross / unclassified). */
export function assertFinalCompanyTransferAllowed(args: {
  final_company_available_pence: number | null | undefined;
  amount_pence?: number | null;
  reserve_reason_code?: string | null;
}): void {
  if (args.final_company_available_pence == null) {
    throw new Error(
      args.reserve_reason_code
        || OPERATIONAL_RESERVE_ERROR.TRANSFER_BLOCKED,
    );
  }
  const amount = args.amount_pence == null ? null : Number(args.amount_pence);
  if (amount != null && amount > args.final_company_available_pence) {
    throw new Error(OPERATIONAL_RESERVE_ERROR.TRANSFER_BLOCKED);
  }
}

export function parsePolicyRow(raw: unknown): CompanyOperationalReservePolicy | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const mode = parseReserveMode(o.reserve_mode);
  const status = parseReservePolicyStatus(o.status);
  if (!mode || !status) return null;
  return {
    id: o.id == null ? null : String(o.id),
    service_area_id: o.service_area_id == null || o.service_area_id === ""
      ? null
      : String(o.service_area_id),
    currency: String(o.currency ?? "GBP").trim().toUpperCase() || "GBP",
    reserve_mode: mode,
    reserve_amount_pence: o.reserve_amount_pence == null
      ? null
      : Math.round(Number(o.reserve_amount_pence)),
    reserve_percentage_bps: o.reserve_percentage_bps == null
      ? null
      : Math.round(Number(o.reserve_percentage_bps)),
    minimum_reserve_pence: o.minimum_reserve_pence == null
      ? null
      : Math.round(Number(o.minimum_reserve_pence)),
    effective_from: o.effective_from == null ? null : String(o.effective_from),
    effective_to: o.effective_to == null ? null : String(o.effective_to),
    status,
    created_by: o.created_by == null ? null : String(o.created_by),
    approved_by: o.approved_by == null ? null : String(o.approved_by),
    created_at: o.created_at == null ? null : String(o.created_at),
    updated_at: o.updated_at == null ? null : String(o.updated_at),
    activated_at: o.activated_at == null ? null : String(o.activated_at),
    disabled_at: o.disabled_at == null ? null : String(o.disabled_at),
    audit_note: o.audit_note == null ? null : String(o.audit_note),
  };
}
