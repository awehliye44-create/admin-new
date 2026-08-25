/**
 * No-show fee settlement.
 *
 * CARD: apply configured no-show fee → capture via provider → ONECAB settlement.
 * CASH:  terminal no_show with all financial amounts zero; payment_status = not_required.
 */

import {
  buildChargedFeeTenLedgerInsert,
  readKnownProviderFeePence,
  resolveChargedTerminalFeeEntitlement,
} from "./chargedTerminalFeeWalletSSOT.ts";
import { tripBlocksDriverWalletLedgerPosting } from "./commissionWalletDeduction.ts";

export type NoShowPaymentStatus =
  | "not_required"
  | "no_show_waived"
  | "no_show_cash_unpaid"
  | "no_show_customer_debt"
  | "no_show_company_compensated"
  | "fee_charged";

export const NO_SHOW_DRIVER_MESSAGE =
  "No-show recorded. Fee will be handled by ONECAB.";

export const NO_SHOW_DRIVER_MESSAGE_WAIVED =
  "No-show recorded. No fee applies for this trip.";

export const NO_SHOW_DRIVER_MESSAGE_CASH =
  "No-show recorded. No fee applies for cash trips.";

/** Trip row financial fields cleared for cash no-show (£0 policy). */
export const CASH_NO_SHOW_ZERO_FINANCIAL_PATCH = {
  payment_status: "not_required",
  financial_outcome: "NO_SHOW",
  debt_recovery_pence: 0,
  gross_fare_pence: 0,
  no_show_charge_pence: 0,
  commission_pence: 0,
  driver_net_pence: 0,
  driver_net_amount: 0,
  driver_total_earnings_pence: 0,
  final_fare_pence: 0,
  final_customer_fare_pence: 0,
  capture_amount_pence: 0,
  onecab_net_pence: 0,
  commissionable_fare_pence: 0,
  fare: 0,
  estimated_total_pence: 0,
} as const;

const LEDGER_TEN = "TRIP_EARNING_NET";
/** Legacy company-comp rows (debt path only — not captured card fee). */
const LEDGER_DRIVER_COMPENSATION = "DRIVER_COMPENSATION_CREDIT";

export interface NoShowSettlementInput {
  supabase: any;
  tripId: string;
  driverId: string;
  passengerId: string | null;
  paymentMethod: string | null;
  financialModel?: string | null;
  currencyCode: string | null;
  feePence: number;
  cardCharged: boolean;
  serviceRoleKey?: string;
  supabaseUrl?: string;
}

export interface NoShowSettlementResult {
  paymentStatus: NoShowPaymentStatus;
  driverCompensated: boolean;
  customerDebtPence: number;
  driverMessage: string;
}

export function isCashPayment(method: string | null | undefined): boolean {
  return (method ?? "").toLowerCase() === "cash";
}

// deno-lint-ignore no-explicit-any
async function ledgerExists(
  supabase: any,
  tripId: string,
  type: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("driver_wallet_ledger")
    .select("id")
    .eq("related_trip_id", tripId)
    .eq("type", type)
    .maybeSingle();
  return !!data;
}

// deno-lint-ignore no-explicit-any
async function resolveAuthoritativeCapturedFeeSession(
  supabase: any,
  tripId: string,
  fallbackFeePence: number,
): Promise<{
  capturedFeePence: number;
  providerFeePence: number | null;
  feeStatus: string | null;
}> {
  const { data: psRows } = await supabase
    .from("payment_sessions")
    .select(
      "id, captured_amount_pence, provider_processing_fee_pence, fee_status, status, provider_state",
    )
    .eq("trip_id", tripId)
    .eq("purpose", "RIDE_BOOKING")
    .order("created_at", { ascending: true })
    .limit(2);
  const ps = Array.isArray(psRows) && psRows.length === 1 ? psRows[0] : null;
  const psCaptured = Math.max(0, Math.round(Number(ps?.captured_amount_pence) || 0));
  const capturedFeePence = psCaptured > 0
    ? psCaptured
    : Math.max(0, Math.round(Number(fallbackFeePence) || 0));
  return {
    capturedFeePence,
    providerFeePence: readKnownProviderFeePence(ps?.provider_processing_fee_pence),
    feeStatus: (ps?.fee_status as string | null) ?? null,
  };
}

// deno-lint-ignore no-explicit-any
async function recordCapturedNoShowTen(
  supabase: any,
  input: {
    driverId: string;
    tripId: string;
    feePence: number;
    currency: string;
  },
): Promise<{ ok: boolean; driverNetPence: number | null; capturedFeePence: number }> {
  const { driverId, tripId, currency } = input;
  const session = await resolveAuthoritativeCapturedFeeSession(
    supabase,
    tripId,
    input.feePence,
  );
  const entitlement = resolveChargedTerminalFeeEntitlement({
    outcome: "NO_SHOW",
    feePence: session.capturedFeePence,
    providerFeePence: session.providerFeePence,
    feeStatus: session.feeStatus,
  });
  if (!entitlement.ok) {
    console.error("[settleNoShowFee] entitlement rejected", entitlement.reason, {
      tripId,
      captured: session.capturedFeePence,
      providerFee: session.providerFeePence,
    });
    return {
      ok: false,
      driverNetPence: null,
      capturedFeePence: session.capturedFeePence,
    };
  }

  if (await tripBlocksDriverWalletLedgerPosting(supabase, tripId)) {
    console.error("[settleNoShowFee] FINANCIAL_MODEL_VIOLATION — DWL forbidden", tripId);
    return {
      ok: false,
      driverNetPence: entitlement.driver_net_pence,
      capturedFeePence: entitlement.captured_fee_pence,
    };
  }

  if (await ledgerExists(supabase, tripId, LEDGER_TEN)) {
    return {
      ok: true,
      driverNetPence: entitlement.driver_net_pence,
      capturedFeePence: entitlement.captured_fee_pence,
    };
  }

  const { error } = await supabase.from("driver_wallet_ledger").insert(
    buildChargedFeeTenLedgerInsert({
      driverId,
      tripId,
      feePence: entitlement.driver_net_pence,
      currency: currency.toUpperCase(),
      outcome: "NO_SHOW",
      capturedFeePence: entitlement.captured_fee_pence,
      providerFeePence: entitlement.provider_fee_pence,
    }),
  );
  if (error && error.code !== "23505") {
    console.error("[settleNoShowFee] TEN insert failed", error);
    return {
      ok: false,
      driverNetPence: entitlement.driver_net_pence,
      capturedFeePence: entitlement.captured_fee_pence,
    };
  }
  const ok = await ledgerExists(supabase, tripId, LEDGER_TEN);
  return {
    ok,
    driverNetPence: entitlement.driver_net_pence,
    capturedFeePence: entitlement.captured_fee_pence,
  };
}

// deno-lint-ignore no-explicit-any
async function recordCompanyCompDebtPath(
  supabase: any,
  input: {
    driverId: string;
    tripId: string;
    feePence: number;
    currency: string;
  },
): Promise<boolean> {
  const { driverId, tripId, feePence, currency } = input;
  if (feePence <= 0) return false;

  // Prefer TEN if already posted (idempotent with cancel-trip / RFO path).
  if (await ledgerExists(supabase, tripId, LEDGER_TEN)) {
    return true;
  }
  if (await ledgerExists(supabase, tripId, LEDGER_DRIVER_COMPENSATION)) {
    return true;
  }

  const cs = currency.toUpperCase();
  const major = (feePence / 100).toFixed(2);

  await supabase.from("driver_wallet_ledger").insert({
    driver_id: driverId,
    related_trip_id: tripId,
    type: LEDGER_DRIVER_COMPENSATION,
    amount_pence: feePence,
    currency: cs,
    description: `No-show company compensation (uncaptured debt path) — ${cs} ${major}`,
  });

  return await ledgerExists(supabase, tripId, LEDGER_DRIVER_COMPENSATION);
}

// deno-lint-ignore no-explicit-any
async function recordCustomerOutstandingBalance(
  supabase: any,
  input: {
    passengerId: string;
    tripId: string;
    feePence: number;
  },
): Promise<void> {
  const { passengerId, tripId, feePence } = input;
  if (feePence <= 0) return;

  const { data: existing } = await supabase
    .from("customer_wallet_ledger")
    .select("id")
    .eq("trip_id", tripId)
    .eq("entry_type", "customer_outstanding_balance")
    .maybeSingle();

  if (existing) return;

  const { data: wallet } = await supabase
    .from("customer_wallets")
    .select("id, currency")
    .eq("customer_id", passengerId)
    .maybeSingle();

  if (!wallet) return;

  await supabase.from("customer_wallet_ledger").insert({
    wallet_id: wallet.id,
    trip_id: tripId,
    entry_type: "customer_outstanding_balance",
    amount_pence: feePence,
    status: "pending",
    description: `Outstanding no-show fee — trip ${input.tripId.slice(0, 8)}`,
  });
}

/**
 * Post no-show financial settlement after trip row is terminal.
 */
export async function settleNoShowFee(
  input: NoShowSettlementInput,
): Promise<NoShowSettlementResult> {
  const {
    supabase,
    tripId,
    driverId,
    passengerId,
    paymentMethod,
    financialModel,
    currencyCode,
    feePence,
    cardCharged,
  } = input;

  const currency = (currencyCode ?? "GBP").toUpperCase();
  const driverCollected =
    String(financialModel ?? "").toUpperCase() === "DRIVER_COLLECTED_COMMISSION_WALLET";
  const cash = isCashPayment(paymentMethod) || driverCollected;

  if (cash) {
    await supabase
      .from("trips")
      .update({
        ...CASH_NO_SHOW_ZERO_FINANCIAL_PATCH,
        updated_at: new Date().toISOString(),
      })
      .eq("id", tripId);

    return {
      paymentStatus: "not_required",
      driverCompensated: false,
      customerDebtPence: 0,
      driverMessage: NO_SHOW_DRIVER_MESSAGE_CASH,
    };
  }

  if (feePence <= 0) {
    await supabase
      .from("trips")
      .update({
        payment_status: "no_show_waived",
        financial_outcome: "NO_SHOW",
        debt_recovery_pence: 0,
        gross_fare_pence: 0,
        no_show_charge_pence: 0,
        updated_at: new Date().toISOString(),
      })
      .eq("id", tripId);

    return {
      paymentStatus: "no_show_waived",
      driverCompensated: false,
      customerDebtPence: 0,
      driverMessage: NO_SHOW_DRIVER_MESSAGE_WAIVED,
    };
  }

  let paymentStatus: NoShowPaymentStatus;
  let customerDebtPence = 0;
  let driverCompensated = false;

  // Card path: TEN / trip stamps use PS captured − known provider fee.
  const feeSession = cardCharged
    ? await resolveAuthoritativeCapturedFeeSession(supabase, tripId, feePence)
    : {
      capturedFeePence: feePence,
      providerFeePence: null as number | null,
      feeStatus: null as string | null,
    };
  const authoritativeFeePence = feeSession.capturedFeePence;

  let cardDriverNet: number | null = null;
  if (cardCharged) {
    paymentStatus = "fee_charged";
    const tenResult = await recordCapturedNoShowTen(supabase, {
      driverId,
      tripId,
      feePence: authoritativeFeePence,
      currency,
    });
    driverCompensated = tenResult.ok;
    cardDriverNet = tenResult.driverNetPence;
  } else {
    paymentStatus = "no_show_customer_debt";
    customerDebtPence = feePence;
    driverCompensated = await recordCompanyCompDebtPath(supabase, {
      driverId,
      tripId,
      feePence,
      currency,
    });
    if (driverCompensated) {
      paymentStatus = "no_show_company_compensated";
    }
    if (passengerId) {
      await recordCustomerOutstandingBalance(supabase, {
        passengerId,
        tripId,
        feePence,
      });
    }
  }

  const tripUpdate: Record<string, unknown> = {
    payment_status: paymentStatus,
    financial_outcome: "NO_SHOW",
    debt_recovery_pence: customerDebtPence,
    no_show_charge_pence: cardCharged ? authoritativeFeePence : feePence,
    updated_at: new Date().toISOString(),
  };
  if (cardCharged) {
    tripUpdate.gross_fare_pence = authoritativeFeePence;
    tripUpdate.commission_pence = 0;
    tripUpdate.commission_pct = 0;
    // Only stamp driver_net when fee-net TEN was computed (known provider fee).
    if (cardDriverNet != null && cardDriverNet > 0) {
      tripUpdate.driver_net_pence = cardDriverNet;
      tripUpdate.driver_net_before_tip_pence = cardDriverNet;
    }
  } else {
    tripUpdate.gross_fare_pence = 0;
  }

  await supabase
    .from("trips")
    .update(tripUpdate)
    .eq("id", tripId);

  return {
    paymentStatus,
    driverCompensated,
    customerDebtPence,
    driverMessage: NO_SHOW_DRIVER_MESSAGE,
  };
}

/** Admin display labels for trips.payment_status (no-show subset). */
export const NO_SHOW_PAYMENT_STATUS_LABELS: Record<string, string> = {
  not_required: "No-show (cash) — no payment required",
  no_show_waived: "No-show — fee waived",
  no_show_cash_unpaid: "No-show (cash) — customer debt pending",
  no_show_customer_debt: "No-show — customer outstanding balance",
  no_show_company_compensated: "No-show — company compensated driver",
  fee_charged: "No-show fee charged (card)",
};
