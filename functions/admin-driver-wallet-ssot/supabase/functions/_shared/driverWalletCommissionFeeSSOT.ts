/**
 * Driver Wallet / ONECAB commission vs provider fee SSOT.
 * Provider fees are external costs — never ONECAB revenue.
 * Gross − Provider Fee = Net ONECAB commission.
 */

export type ProviderFeeStatusUi =
  | "ESTIMATED"
  | "CONFIRMED"
  | "ADJUSTED"
  | "MISSING"
  | "NOT_APPLICABLE";

export type ProviderFeeConfigInput = {
  provider_name: string;
  fee_type?: string | null;
  percentage_fee_bps?: number | null;
  fixed_fee_pence?: number | null;
  currency_code?: string | null;
  version?: string | null;
  effective_from?: string | null;
  payment_method?: string | null;
};

export type CommissionFeeTripInput = {
  trip_id: string;
  trip_code?: string | null;
  completed_at?: string | null;
  payment_provider?: string | null;
  payment_method?: string | null;
  /** Fare base used for commission (pence). Prefer final_customer_fare / commissionable. */
  commissionable_fare_pence?: number | null;
  commission_rate_percent?: number | null;
  /** Gross platform commission from trip settlement (pence). */
  gross_commission_pence?: number | null;
  provider_transaction_id?: string | null;
};

export type CommissionFeeSessionInput = {
  payment_session_id?: string | null;
  payment_provider?: string | null;
  payment_method?: string | null;
  provider_processing_fee_pence?: number | null;
  fee_status?: string | null;
  /** Immutable snapshots if present (never invent). */
  provider_fee_percentage_snapshot?: number | null;
  provider_fixed_fee_snapshot?: number | null;
  provider_fee_total_snapshot?: number | null;
  provider_fee_version_snapshot?: string | null;
  provider_fee_currency_snapshot?: string | null;
  provider_transaction_id?: string | null;
  provider_fee_source?: string | null;
  provider_fee_confirmed_at?: string | null;
};

export type CommissionFeeBreakdownRow = {
  trip_id: string;
  trip_code: string | null;
  completed_at: string | null;
  payment_provider: string | null;
  payment_method: string | null;
  commissionable_fare_pence: number | null;
  commission_rate_percent: number | null;
  gross_onecab_commission_pence: number;
  provider_percentage_fee_pence: number | null;
  provider_fixed_fee_pence: number | null;
  total_provider_fee_pence: number;
  net_onecab_commission_pence: number;
  provider_transaction_id: string | null;
  fee_configuration_version: string | null;
  provider_fee_status: ProviderFeeStatusUi;
  provider_fee_source: string | null;
  payment_session_id: string | null;
};

export type CommissionFeeSummary = {
  gross_onecab_commission_pence: number;
  payment_provider_fees_pence: number;
  net_onecab_commission_pence: number;
  transaction_count: number;
};

/** Map Payment Sessions fee_status → Commission UI status. */
export function mapProviderFeeStatus(
  raw: string | null | undefined,
  args?: { isCash?: boolean; feePence?: number | null },
): ProviderFeeStatusUi {
  if (args?.isCash) return "NOT_APPLICABLE";
  const s = String(raw ?? "").toUpperCase();
  if (s === "ACTUAL" || s === "CONFIRMED") return "CONFIRMED";
  if (s === "ESTIMATED") return "ESTIMATED";
  if (s === "ADJUSTED") return "ADJUSTED";
  if (s === "PENDING") return args?.feePence != null && args.feePence > 0 ? "ESTIMATED" : "MISSING";
  if (s === "UNAVAILABLE" || s === "MISSING") return "MISSING";
  if (args?.feePence != null && args.feePence > 0) return "CONFIRMED";
  return "MISSING";
}

export function estimateProviderFeePence(args: {
  commissionableFarePence: number;
  percentageFeeBps?: number | null;
  fixedFeePence?: number | null;
}): { percentage_fee_pence: number; fixed_fee_pence: number; total_fee_pence: number } {
  const fare = Math.max(0, Math.round(args.commissionableFarePence));
  const bps = Math.max(0, Number(args.percentageFeeBps ?? 0));
  const fixed = Math.max(0, Math.round(Number(args.fixedFeePence ?? 0)));
  const percentage = Math.round((fare * bps) / 10_000);
  return {
    percentage_fee_pence: percentage,
    fixed_fee_pence: fixed,
    total_fee_pence: percentage + fixed,
  };
}

/**
 * Gross ONECAB − provider fee = net ONECAB.
 * Provider fee is never ONECAB revenue.
 */
export function computeOnecabCommissionAfterProviderFee(args: {
  grossCommissionPence: number | null | undefined;
  providerFeePence: number | null | undefined;
}): {
  gross_onecab_commission_pence: number;
  total_provider_fee_pence: number;
  net_onecab_commission_pence: number;
} {
  const gross = Math.max(0, Math.round(Number(args.grossCommissionPence ?? 0)));
  const fee = Math.max(0, Math.round(Number(args.providerFeePence ?? 0)));
  return {
    gross_onecab_commission_pence: gross,
    total_provider_fee_pence: fee,
    net_onecab_commission_pence: Math.max(0, gross - fee),
  };
}

function isCashPaymentMethod(method: string | null | undefined): boolean {
  const m = String(method ?? "").trim().toLowerCase();
  return m === "cash" || m.includes("cash");
}

/**
 * Build one commission/fee display row.
 * Fee priority: confirmed/snapshot total → session fee → config estimate → MISSING.
 */
export function buildCommissionFeeBreakdownRow(args: {
  trip: CommissionFeeTripInput;
  session?: CommissionFeeSessionInput | null;
  feeConfig?: ProviderFeeConfigInput | null;
}): CommissionFeeBreakdownRow {
  const trip = args.trip;
  const session = args.session ?? null;
  const config = args.feeConfig ?? null;
  const method = session?.payment_method ?? trip.payment_method ?? null;
  const cash = isCashPaymentMethod(method);
  const fare = trip.commissionable_fare_pence == null
    ? null
    : Math.max(0, Math.round(Number(trip.commissionable_fare_pence)));
  const rate = trip.commission_rate_percent == null
    ? null
    : Number(trip.commission_rate_percent);
  const grossFromTrip = trip.gross_commission_pence == null
    ? null
    : Math.max(0, Math.round(Number(trip.gross_commission_pence)));
  const gross = grossFromTrip != null
    ? grossFromTrip
    : (fare != null && rate != null ? Math.round((fare * rate) / 100) : 0);

  let percentageFee: number | null = null;
  let fixedFee: number | null = null;
  let totalFee = 0;
  let feeSource: string | null = null;
  let version: string | null = session?.provider_fee_version_snapshot ?? config?.version ?? null;

  if (cash) {
    const split = computeOnecabCommissionAfterProviderFee({
      grossCommissionPence: gross,
      providerFeePence: 0,
    });
    return {
      trip_id: trip.trip_id,
      trip_code: trip.trip_code ?? null,
      completed_at: trip.completed_at ?? null,
      payment_provider: session?.payment_provider ?? trip.payment_provider ?? null,
      payment_method: method,
      commissionable_fare_pence: fare,
      commission_rate_percent: rate,
      gross_onecab_commission_pence: split.gross_onecab_commission_pence,
      provider_percentage_fee_pence: 0,
      provider_fixed_fee_pence: 0,
      total_provider_fee_pence: 0,
      net_onecab_commission_pence: split.net_onecab_commission_pence,
      provider_transaction_id: session?.provider_transaction_id ?? trip.provider_transaction_id ?? null,
      fee_configuration_version: version,
      provider_fee_status: "NOT_APPLICABLE",
      provider_fee_source: "cash",
      payment_session_id: session?.payment_session_id ?? null,
    };
  }

  if (session?.provider_fee_total_snapshot != null) {
    totalFee = Math.max(0, Math.round(Number(session.provider_fee_total_snapshot)));
    percentageFee = session.provider_fee_percentage_snapshot == null
      ? null
      : Math.max(0, Math.round(Number(session.provider_fee_percentage_snapshot)));
    fixedFee = session.provider_fixed_fee_snapshot == null
      ? null
      : Math.max(0, Math.round(Number(session.provider_fixed_fee_snapshot)));
    feeSource = session.provider_fee_source ?? "snapshot";
  } else if (session?.provider_processing_fee_pence != null) {
    totalFee = Math.max(0, Math.round(Number(session.provider_processing_fee_pence)));
    feeSource = session.provider_fee_source ?? "payment_session";
    // Split estimate for display when only total is known.
    if (fare != null && config) {
      const est = estimateProviderFeePence({
        commissionableFarePence: fare,
        percentageFeeBps: config.percentage_fee_bps,
        fixedFeePence: config.fixed_fee_pence,
      });
      // Prefer config split shapes when totals match closely; else fixed carries residual.
      if (Math.abs(est.total_fee_pence - totalFee) <= 1) {
        percentageFee = est.percentage_fee_pence;
        fixedFee = est.fixed_fee_pence;
      } else {
        percentageFee = null;
        fixedFee = totalFee;
      }
    } else {
      fixedFee = totalFee;
    }
  } else if (config && fare != null) {
    const est = estimateProviderFeePence({
      commissionableFarePence: fare,
      percentageFeeBps: config.percentage_fee_bps,
      fixedFeePence: config.fixed_fee_pence,
    });
    percentageFee = est.percentage_fee_pence;
    fixedFee = est.fixed_fee_pence;
    totalFee = est.total_fee_pence;
    feeSource = "fee_configuration_estimate";
    version = config.version ?? version;
  }

  const status = mapProviderFeeStatus(session?.fee_status, {
    isCash: false,
    feePence: totalFee > 0 ? totalFee : null,
  });
  // If we only have a config estimate, force ESTIMATED.
  const finalStatus = feeSource === "fee_configuration_estimate" && status === "MISSING"
    ? "ESTIMATED"
    : (totalFee === 0 && !session ? "MISSING" : status);

  const split = computeOnecabCommissionAfterProviderFee({
    grossCommissionPence: gross,
    providerFeePence: totalFee,
  });

  return {
    trip_id: trip.trip_id,
    trip_code: trip.trip_code ?? null,
    completed_at: trip.completed_at ?? null,
    payment_provider: session?.payment_provider ?? trip.payment_provider ?? config?.provider_name ?? null,
    payment_method: method,
    commissionable_fare_pence: fare,
    commission_rate_percent: rate,
    gross_onecab_commission_pence: split.gross_onecab_commission_pence,
    provider_percentage_fee_pence: percentageFee,
    provider_fixed_fee_pence: fixedFee,
    total_provider_fee_pence: split.total_provider_fee_pence,
    net_onecab_commission_pence: split.net_onecab_commission_pence,
    provider_transaction_id: session?.provider_transaction_id ?? trip.provider_transaction_id ?? null,
    fee_configuration_version: version,
    provider_fee_status: finalStatus,
    provider_fee_source: feeSource,
    payment_session_id: session?.payment_session_id ?? null,
  };
}

export function summarizeCommissionFeeRows(rows: CommissionFeeBreakdownRow[]): CommissionFeeSummary {
  let gross = 0;
  let fees = 0;
  let net = 0;
  for (const row of rows) {
    gross += row.gross_onecab_commission_pence;
    fees += row.total_provider_fee_pence;
    net += row.net_onecab_commission_pence;
  }
  return {
    gross_onecab_commission_pence: gross,
    payment_provider_fees_pence: fees,
    net_onecab_commission_pence: net,
    transaction_count: rows.length,
  };
}

/** Attach running net ONECAB balance (newest-first input → display newest-first with balance). */
export function attachRunningNetOnecabBalanceNewestFirst(
  rowsNewestFirst: CommissionFeeBreakdownRow[],
): Array<CommissionFeeBreakdownRow & { running_net_onecab_balance_pence: number }> {
  const chronological = [...rowsNewestFirst].reverse();
  let bal = 0;
  const withBal = chronological.map((row) => {
    bal += row.net_onecab_commission_pence;
    return { ...row, running_net_onecab_balance_pence: bal };
  });
  return withBal.reverse();
}
