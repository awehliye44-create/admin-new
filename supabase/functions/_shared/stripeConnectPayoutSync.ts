/**
 * Persist Stripe Connect payout objects for admin historical visibility.
 */
import type Stripe from "https://esm.sh/stripe@14.21.0";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export type StripeConnectPayoutRow = {
  payout_id: string;
  connected_account_id: string;
  driver_id: string | null;
  amount_pence: number;
  currency: string;
  status: string;
  initiated_at: string | null;
  arrival_date: string | null;
  bank_last4: string | null;
  failure_code: string | null;
  failure_message: string | null;
  balance_transaction_id: string | null;
  payout_method: string | null;
  statement_descriptor: string | null;
  last_synced_at: string;
};

function payoutMethodLabel(payout: Stripe.Payout): string {
  if (payout.method === "instant") return "instant";
  if (payout.type === "bank_account") return "standard";
  return String(payout.method ?? payout.type ?? "standard");
}

export async function upsertStripeConnectPayout(args: {
  supabase: SupabaseClient;
  stripe?: Stripe;
  payout: Stripe.Payout;
  connectedAccountId: string;
  driverId: string | null;
  syncedAt: string;
}): Promise<void> {
  const balanceTxnId = typeof args.payout.balance_transaction === "string"
    ? args.payout.balance_transaction
    : args.payout.balance_transaction?.id ?? null;

  let bankLast4: string | null = null;
  const dest = args.payout.destination;
  if (dest && typeof dest === "object" && "last4" in dest) {
    bankLast4 = (dest as { last4?: string | null }).last4 ?? null;
  } else if (typeof dest === "string" && args.stripe) {
    try {
      const external = await args.stripe.accounts.retrieveExternalAccount(
        args.connectedAccountId,
        dest,
      );
      if (external && typeof external === "object" && "last4" in external) {
        bankLast4 = (external as { last4?: string | null }).last4 ?? null;
      }
    } catch {
      bankLast4 = null;
    }
  }

  const { error } = await args.supabase.from("stripe_connect_payouts").upsert({
    payout_id: args.payout.id,
    connected_account_id: args.connectedAccountId,
    driver_id: args.driverId,
    amount_pence: Math.max(0, Number(args.payout.amount ?? 0)),
    currency: String(args.payout.currency ?? "gbp").toLowerCase(),
    status: String(args.payout.status ?? "unknown"),
    initiated_at: args.payout.created
      ? new Date(args.payout.created * 1000).toISOString()
      : null,
    arrival_date: args.payout.arrival_date
      ? new Date(args.payout.arrival_date * 1000).toISOString()
      : null,
    bank_last4: bankLast4,
    failure_code: args.payout.failure_code ?? null,
    failure_message: args.payout.failure_message ?? null,
    balance_transaction_id: balanceTxnId,
    payout_method: payoutMethodLabel(args.payout),
    statement_descriptor: args.payout.statement_descriptor ?? null,
    last_synced_at: args.syncedAt,
    updated_at: args.syncedAt,
  }, { onConflict: "payout_id" });

  if (error) throw new Error(`stripe_connect_payouts upsert failed: ${error.message}`);
}

export async function syncStripeConnectPayoutsForAccount(args: {
  supabase: SupabaseClient;
  stripe: Stripe;
  driverId: string;
  connectedAccountId: string;
  currency?: string;
  limit?: number;
}): Promise<{ synced: number; payouts: StripeConnectPayoutRow[] }> {
  const syncedAt = new Date().toISOString();
  const currency = (args.currency ?? "gbp").toLowerCase();
  const limit = args.limit ?? 100;

  const list = await args.stripe.payouts.list(
    { limit },
    { stripeAccount: args.connectedAccountId },
  );

  let synced = 0;
  for (const payout of list.data) {
    if (String(payout.currency ?? "").toLowerCase() !== currency) continue;
    await upsertStripeConnectPayout({
      supabase: args.supabase,
      stripe: args.stripe,
      payout,
      connectedAccountId: args.connectedAccountId,
      driverId: args.driverId,
      syncedAt,
    });
    synced += 1;
  }

  const { data, error } = await args.supabase
    .from("stripe_connect_payouts")
    .select("*")
    .eq("driver_id", args.driverId)
    .order("initiated_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(error.message);

  return {
    synced,
    payouts: (data ?? []).map((row) => ({
      payout_id: String(row.payout_id),
      connected_account_id: String(row.connected_account_id),
      driver_id: row.driver_id as string | null,
      amount_pence: Number(row.amount_pence ?? 0),
      currency: String(row.currency ?? currency),
      status: String(row.status ?? ""),
      initiated_at: row.initiated_at as string | null,
      arrival_date: row.arrival_date as string | null,
      bank_last4: row.bank_last4 as string | null,
      failure_code: row.failure_code as string | null,
      failure_message: row.failure_message as string | null,
      balance_transaction_id: row.balance_transaction_id as string | null,
      payout_method: row.payout_method as string | null,
      statement_descriptor: row.statement_descriptor as string | null,
      last_synced_at: String(row.last_synced_at ?? syncedAt),
    })),
  };
}

export async function syncStripeConnectPayoutsForRegion(args: {
  supabase: SupabaseClient;
  stripe: Stripe;
  regionId?: string | null;
  currency?: string;
}): Promise<{ accounts_synced: number; payouts_synced: number }> {
  let driverQuery = args.supabase
    .from("drivers")
    .select("id, stripe_account_id, region_id")
    .not("stripe_account_id", "is", null);

  if (args.regionId) driverQuery = driverQuery.eq("region_id", args.regionId);

  const { data: drivers, error } = await driverQuery;
  if (error) throw new Error(error.message);

  let accountsSynced = 0;
  let payoutsSynced = 0;

  for (const driver of drivers ?? []) {
    const acct = String(driver.stripe_account_id ?? "");
    if (!acct) continue;
    const result = await syncStripeConnectPayoutsForAccount({
      supabase: args.supabase,
      stripe: args.stripe,
      driverId: String(driver.id),
      connectedAccountId: acct,
      currency: args.currency,
    });
    accountsSynced += 1;
    payoutsSynced += result.synced;
  }

  return { accounts_synced: accountsSynced, payouts_synced: payoutsSynced };
}
