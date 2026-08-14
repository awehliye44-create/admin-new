/**
 * No-show fee settlement.
 *
 * CARD: apply configured no-show fee → capture via Stripe → ONECAB settlement.
 * CASH:  terminal no_show with all financial amounts zero; payment_status = not_required.
 */

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

const LEDGER_DRIVER_COMPENSATION = "DRIVER_COMPENSATION_CREDIT";
const LEDGER_NO_SHOW_FEE = "NO_SHOW_FEE";

export interface NoShowSettlementInput {
  supabase: any;
  tripId: string;
  driverId: string;
  passengerId: string | null;
  paymentMethod: string | null;
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
async function recordDriverCompensation(
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
    description: `No-show compensation (ONECAB) — ${cs} ${major}`,
  });

  if (!(await ledgerExists(supabase, tripId, LEDGER_NO_SHOW_FEE))) {
    await supabase.from("driver_wallet_ledger").insert({
      driver_id: driverId,
      related_trip_id: tripId,
      type: LEDGER_NO_SHOW_FEE,
      amount_pence: feePence,
      currency: cs,
      description: `No-show fee — ${cs} ${major}`,
    });
  }

  return true;
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
    currencyCode,
    feePence,
    cardCharged,
  } = input;

  const currency = (currencyCode ?? "GBP").toUpperCase();
  const cash = isCashPayment(paymentMethod);

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

  if (cardCharged) {
    paymentStatus = "fee_charged";
    driverCompensated = await recordDriverCompensation(supabase, {
      driverId,
      tripId,
      feePence,
      currency,
    });
  } else {
    paymentStatus = "no_show_customer_debt";
    customerDebtPence = feePence;
    driverCompensated = await recordDriverCompensation(supabase, {
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

  await supabase
    .from("trips")
    .update({
      payment_status: paymentStatus,
      financial_outcome: "NO_SHOW",
      debt_recovery_pence: customerDebtPence,
      gross_fare_pence: 0,
      no_show_charge_pence: feePence,
      updated_at: new Date().toISOString(),
    })
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
