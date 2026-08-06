/**
 * Driver earnings invoice ledger include/exclude policy (Driver Wallet Ledger SSOT).
 * Top-ups, payouts, commission-wallet activity, and unrelated adjustments are excluded.
 */

export const DRIVER_REPORT_INCLUDED_LEDGER_TYPES = new Set([
  "TRIP_EARNING_NET",
  "CASH_TRIP_EARNING",
  "TIP_CREDIT",
  "DRIVER_TIP_CREDIT",
  "PLATFORM_COMMISSION",
  "COMPANY_COMMISSION",
  "BONUS",
  "INCENTIVE",
  "PENALTY",
  "DEDUCTION",
  "NO_SHOW_EARNING",
  "LATE_CANCEL_EARNING",
  // Approved trip-tied earning adjustments only (see classify).
  "ADJUSTMENT",
  "REFUND_DEBIT",
  "LEDGER_REVERSAL",
]);

export const DRIVER_REPORT_EXCLUDED_LEDGER_TYPES = new Set([
  "TOP_UP",
  "WALLET_TOP_UP",
  "DRIVER_TOP_UP",
  "PAYOUT",
  "PAYOUT_RESERVATION",
  "PAYOUT_RELEASE",
  "CASHOUT",
  "WITHDRAWAL",
  "COMMISSION_WALLET_CREDIT",
  "COMMISSION_WALLET_DEBIT",
  "CW_CREDIT",
  "CW_DEBIT",
  "COMPANY_FUNDING",
  "MANUAL_TOP_UP",
  "UNRELATED_ADJUSTMENT",
]);

export type LedgerBucket =
  | "gross_earning"
  | "commission"
  | "bonus"
  | "penalty"
  | "approved_adjustment"
  | "excluded";

export function classifyDriverReportLedgerType(type: string): LedgerBucket {
  const t = (type ?? "").toUpperCase();
  if (DRIVER_REPORT_EXCLUDED_LEDGER_TYPES.has(t)) return "excluded";
  switch (t) {
    case "TRIP_EARNING_NET":
    case "CASH_TRIP_EARNING":
    case "TIP_CREDIT":
    case "DRIVER_TIP_CREDIT":
    case "NO_SHOW_EARNING":
    case "LATE_CANCEL_EARNING":
      return "gross_earning";
    case "PLATFORM_COMMISSION":
    case "COMPANY_COMMISSION":
      return "commission";
    case "BONUS":
    case "INCENTIVE":
      return "bonus";
    case "PENALTY":
    case "DEDUCTION":
      return "penalty";
    case "ADJUSTMENT":
    case "REFUND_DEBIT":
    case "LEDGER_REVERSAL":
      return "approved_adjustment";
    default:
      return "excluded";
  }
}

export type LedgerEntryLike = {
  id?: string;
  type: string;
  amount_pence: number;
  related_trip_id?: string | null;
  driver_id?: string;
};

export type DriverReportTotals = {
  includedIds: string[];
  excludedIds: string[];
  grossEarningsPence: number;
  commissionPence: number;
  bonusesPence: number;
  penaltiesPence: number;
  adjustmentsPence: number;
  netEarningsPence: number;
  tripIds: Set<string>;
};

/** Aggregate only approved net-earning ledger rows for one driver. */
export function aggregateApprovedDriverLedger(
  entries: LedgerEntryLike[],
  driverId: string,
): DriverReportTotals {
  const includedIds: string[] = [];
  const excludedIds: string[] = [];
  let gross = 0;
  let commission = 0;
  let bonuses = 0;
  let penalties = 0;
  let adjustments = 0;
  const tripIds = new Set<string>();

  for (const e of entries) {
    if (e.driver_id && e.driver_id !== driverId) {
      if (e.id) excludedIds.push(e.id);
      continue;
    }
    const bucket = classifyDriverReportLedgerType(e.type);
    const amt = Number(e.amount_pence ?? 0);
    const id = e.id ?? `${e.type}:${amt}:${e.related_trip_id ?? ""}`;

    if (bucket === "excluded") {
      excludedIds.push(id);
      continue;
    }

    includedIds.push(id);
    switch (bucket) {
      case "gross_earning":
        gross += amt;
        if (e.related_trip_id) tripIds.add(e.related_trip_id);
        break;
      case "commission":
        commission += Math.abs(amt);
        break;
      case "bonus":
        bonuses += amt;
        break;
      case "penalty":
        penalties += Math.abs(amt);
        break;
      case "approved_adjustment":
        adjustments += amt;
        break;
    }
  }

  return {
    includedIds,
    excludedIds,
    grossEarningsPence: gross,
    commissionPence: commission,
    bonusesPence: bonuses,
    penaltiesPence: penalties,
    adjustmentsPence: adjustments,
    netEarningsPence: gross - commission + bonuses - penalties + adjustments,
    tripIds,
  };
}

export function isEligibleDriverInvoiceEmail(email: string): boolean {
  const value = email.trim().toLowerCase();
  if (!value || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return false;
  const blocked = new Set([
    "info@onecab.net",
    "admin@onecab.net",
    "support@onecab.net",
    "noreply@onecab.net",
    "no-reply@onecab.net",
  ]);
  if (blocked.has(value)) return false;
  if (value.endsWith("@example.com") || value.endsWith("@test.local")) return false;
  return true;
}

/**
 * Driver profile email only — never customer / company / admin fallback.
 */
export function resolvePreferredDriverInvoiceEmail(args: {
  driverProfileEmail: string | null;
  driverAuthEmail: string | null;
  customerProfileEmail: string | null;
  companyEmail: string | null;
  adminEmail: string | null;
}): string | null {
  const direct = args.driverProfileEmail?.trim() || null;
  if (direct && isEligibleDriverInvoiceEmail(direct)) return direct;

  const auth = args.driverAuthEmail?.trim() || null;
  if (auth && isEligibleDriverInvoiceEmail(auth)) return auth;

  void args.customerProfileEmail;
  void args.companyEmail;
  void args.adminEmail;
  return null;
}

export function canMutateDriverInvoiceArtifact(args: {
  status: string | null;
  invoiceEmailSent: boolean;
  action: "generate" | "regenerate" | "send_email" | "download" | "view";
}): { allowed: boolean; reason: string } {
  const issued = args.invoiceEmailSent ||
    ["sent", "viewed"].includes((args.status ?? "").toLowerCase());

  if (args.action === "download" || args.action === "view") {
    return { allowed: true, reason: "read_only" };
  }
  if (args.action === "regenerate" && issued) {
    return { allowed: false, reason: "issued_immutable" };
  }
  if (args.action === "send_email" && args.invoiceEmailSent) {
    return { allowed: false, reason: "already_sent" };
  }
  return { allowed: true, reason: "mutable" };
}

/** Unique period key for driver + period bounds (matches invoices_driver_period_unique). */
export function driverPeriodUniqueKey(
  driverId: string,
  periodStart: string,
  periodEnd: string,
): string {
  return `${driverId}|${periodStart}|${periodEnd}`;
}

export function wouldDuplicateDriverPeriod(
  existingKeys: Set<string>,
  driverId: string,
  periodStart: string,
  periodEnd: string,
): boolean {
  return existingKeys.has(driverPeriodUniqueKey(driverId, periodStart, periodEnd));
}

export function scheduleAllowsAutoReport(args: {
  enabled: boolean;
  is_auto_generate_enabled?: boolean;
}): boolean {
  if (!args.enabled) return false;
  if (args.is_auto_generate_enabled === false) return false;
  return true;
}

export const DRIVER_EARNINGS_PAGE_SLUG = "driver-earnings-invoices";

export function decideDriverInvoicePageAccess(args: {
  isAdminOrStaff: boolean;
  roleCanAccessPage: boolean;
}): { allowed: boolean; code?: string } {
  if (!args.isAdminOrStaff) return { allowed: false, code: "UNAUTHORIZED" };
  if (!args.roleCanAccessPage) return { allowed: false, code: "PAGE_FORBIDDEN" };
  return { allowed: true };
}
