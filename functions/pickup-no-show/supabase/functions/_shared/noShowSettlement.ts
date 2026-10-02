/**
 * No-show fee settlement.
 *
 * CARD: capture via provider → Payment Session evidence → canonical entitlement posting.
 * CASH:  terminal no_show with all financial amounts zero; payment_status = not_required.
 */

import {
  loadTerminalCaptureEvidence,
  postTerminalEntitlementFromSettlement,
  stampTerminalOutcomeTripRow,
} from "./terminalOutcomeEntitlementSSOT.ts";

export type NoShowPaymentStatus =
  | "not_required"
  | "no_show_waived"
  | "no_show_cash_unpaid"
  | "no_show_customer_debt"
  | "no_show_company_compensated"
  | "fee_charged"
  | "fee_pending_settlement";

export const NO_SHOW_DRIVER_MESSAGE =
  "No-show recorded. Fee will be handled by ONECAB.";

export const NO_SHOW_DRIVER_MESSAGE_WAIVED =
  "No-show recorded. No fee applies for this trip.";

export const NO_SHOW_DRIVER_MESSAGE_CASH =
  "No-show recorded. No fee applies for cash trips.";

export const NO_SHOW_DRIVER_MESSAGE_PENDING =
  "No-show recorded. Driver compensation pending provider fee confirmation.";

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
  entitlement_pence?: number | null;
  pending_settlement?: boolean;
}

export function isCashPayment(method: string | null | undefined): boolean {
  return (method ?? "").toLowerCase() === "cash";
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
 * Wallet credit uses canonical terminal entitlement — never raw feePence.
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

  const evidence = await loadTerminalCaptureEvidence(supabase, tripId, cardCharged ? feePence : null);
  await stampTerminalOutcomeTripRow({
    supabase,
    tripId,
    outcome: "NO_SHOW",
    evidence,
    paymentMethod,
  });

  const posted = await postTerminalEntitlementFromSettlement({
    supabase,
    tripId,
    driverId,
    outcome: "NO_SHOW",
    currency,
    evidence,
  });

  let paymentStatus: NoShowPaymentStatus;
  let customerDebtPence = 0;

  if (posted.pending) {
    paymentStatus = "fee_pending_settlement";
  } else if (cardCharged) {
    paymentStatus = posted.credited ? "fee_charged" : "fee_pending_settlement";
  } else {
    paymentStatus = "no_show_customer_debt";
    customerDebtPence = feePence;
    if (posted.credited) {
      paymentStatus = "no_show_company_compensated";
    }
    if (passengerId && !cardCharged) {
      await recordCustomerOutstandingBalance(supabase, {
        passengerId,
        tripId,
        feePence,
      });
    }
  }

  await supabase
    .from("trips")
    .update({
      payment_status: paymentStatus,
      financial_outcome: "NO_SHOW",
      debt_recovery_pence: customerDebtPence,
      gross_fare_pence: evidence.captured_pence,
      no_show_charge_pence: feePence,
      capture_amount_pence: evidence.captured_pence,
      driver_net_pence: posted.entitlement_pence ?? 0,
      commission_pence: 0,
      updated_at: new Date().toISOString(),
    })
    .eq("id", tripId);

  return {
    paymentStatus,
    driverCompensated: posted.credited,
    customerDebtPence,
    driverMessage: posted.pending ? NO_SHOW_DRIVER_MESSAGE_PENDING : NO_SHOW_DRIVER_MESSAGE,
    entitlement_pence: posted.entitlement_pence,
    pending_settlement: posted.pending,
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
  fee_pending_settlement: "No-show — driver compensation pending provider fee",
};
