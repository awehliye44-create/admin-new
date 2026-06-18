import type Stripe from "https://esm.sh/stripe@14.21.0";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export type ConnectPayoutScheduleSnapshot = {
  stripe_account_id: string;
  interval: string | null;
  delay_days: number | null;
  automatic_payouts_enabled: boolean;
  payouts_enabled: boolean | null;
  available_pence: number;
  pending_pence: number;
};

export type InFlightConnectPayout = {
  payout_id: string;
  amount_pence: number;
  status: string;
  automatic: boolean;
  arrival_date: string | null;
};

export function isAutomaticPayoutSchedule(interval: string | null | undefined): boolean {
  return interval != null && interval !== "manual";
}

export async function readConnectPayoutSnapshot(
  stripe: Stripe,
  stripeAccountId: string,
): Promise<ConnectPayoutScheduleSnapshot> {
  const account = await stripe.accounts.retrieve(stripeAccountId);
  const schedule = account.settings?.payouts?.schedule;
  const balance = await stripe.balance.retrieve({ stripeAccount: stripeAccountId });
  const avail = balance.available.find((b) => b.currency === "gbp")?.amount ?? 0;
  const pend = balance.pending.find((b) => b.currency === "gbp")?.amount ?? 0;
  const interval = schedule?.interval ?? null;

  return {
    stripe_account_id: stripeAccountId,
    interval,
    delay_days: schedule?.delay_days ?? null,
    automatic_payouts_enabled: isAutomaticPayoutSchedule(interval),
    payouts_enabled: account.payouts_enabled ?? null,
    available_pence: avail,
    pending_pence: pend,
  };
}

export async function listInFlightConnectPayouts(
  stripe: Stripe,
  stripeAccountId: string,
): Promise<InFlightConnectPayout[]> {
  const byId = new Map<string, InFlightConnectPayout>();
  for (const status of ["pending", "in_transit"] as const) {
    const page = await stripe.payouts.list(
      { limit: 100, status },
      { stripeAccount: stripeAccountId },
    );
    for (const p of page.data) {
      if (p.status !== "pending" && p.status !== "in_transit") continue;
      byId.set(p.id, {
        payout_id: p.id,
        amount_pence: p.amount,
        status: p.status,
        automatic: p.automatic ?? false,
        arrival_date: p.arrival_date
          ? new Date(p.arrival_date * 1000).toISOString()
          : null,
      });
    }
  }
  return [...byId.values()];
}

/** Set Connect account to manual payout schedule (no automatic bank sweeps). */
export async function applyManualConnectPayoutSchedule(
  stripe: Stripe,
  stripeAccountId: string,
): Promise<ConnectPayoutScheduleSnapshot> {
  await stripe.accounts.update(stripeAccountId, {
    settings: {
      payouts: {
        schedule: {
          interval: "manual",
        },
      },
    },
  });
  return readConnectPayoutSnapshot(stripe, stripeAccountId);
}

export async function ensureManualConnectPayoutScheduleViaFetch(
  stripeSecretKey: string,
  stripeAccountId: string,
): Promise<void> {
  const res = await fetch(`https://api.stripe.com/v1/accounts/${stripeAccountId}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${stripeSecretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      "settings[payouts][schedule][interval]": "manual",
    }),
  });
  const body = await res.json();
  if (body.error) {
    throw new Error(body.error.message ?? "Failed to set manual payout schedule");
  }
}

export async function insertConnectPayoutAuditRow(
  supabase: SupabaseClient,
  row: {
    driver_id: string | null;
    stripe_account_id: string;
    action: string;
    before_interval: string | null;
    before_delay_days: number | null;
    after_interval: string | null;
    after_delay_days: number | null;
    in_flight_payout_ids: unknown;
    connect_available_pence: number;
    connect_pending_pence: number;
    performed_by: string | null;
    dry_run: boolean;
    error_message?: string | null;
  },
): Promise<void> {
  const { error } = await supabase.from("stripe_connect_payout_schedule_audit").insert(row);
  if (error) throw error;
}
