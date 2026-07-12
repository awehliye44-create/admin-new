/**
 * Manual provider payout SSOT — Revolut Business bank transfer confirmed by admin.
 * No Merchant/Business API payout retrieve on mark-paid; ledger debit only after reference.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
/** Providers where admin pays from business account and marks paid with a reference. */
export const MANUAL_BANK_PAYOUT_PROVIDERS = new Set<string>(["revolut"]);

export function isManualBankPayoutProvider(provider: string | null | undefined): boolean {
  if (!provider) return false;
  return MANUAL_BANK_PAYOUT_PROVIDERS.has(provider.trim().toLowerCase());
}

export function isLiveDriverPayoutProvider(provider: string | null | undefined): boolean {
  // Stripe is retired from active payouts — only Revolut / manual bank are live.
  return Boolean(provider && ["revolut"].includes(provider.trim().toLowerCase()));
}

/** Wallet-ledger eligibility for manual provider payouts (no Stripe Connect allocation). */
export function manualProviderEligiblePence(args: {
  walletUnpaidPence: number;
  inFlightPayoutPence?: number;
  payoutBlocked?: boolean;
}): number {
  if (args.payoutBlocked) return 0;
  const wallet = Math.max(0, args.walletUnpaidPence);
  const inFlight = Math.max(0, args.inFlightPayoutPence ?? 0);
  return Math.max(0, wallet - inFlight);
}

/**
 * Resolve driver payout provider for a service area.
 * Prefer driver_payout_gateway — never let legacy payment_provider='stripe' override Revolut payouts.
 */
export function providerFromServiceArea(area: {
  payment_provider?: string | null;
  driver_payout_gateway?: string | null;
  customer_payment_gateway?: string | null;
}): string | null {
  const payoutGw = String(area.driver_payout_gateway ?? "").trim().toLowerCase();
  if (payoutGw && payoutGw !== "stripe") return payoutGw;
  if (payoutGw === "stripe") {
    // Retired — fall through; never return stripe as active payout provider.
  }
  const payment = String(area.payment_provider ?? "").trim().toLowerCase();
  if (payment && payment !== "stripe") return payment;
  const customer = String(area.customer_payment_gateway ?? "").trim().toLowerCase();
  if (customer && customer !== "stripe") return customer;
  return null;
}

export async function resolveRegionPayoutProvider(
  supabase: SupabaseClient,
  regionId: string | null | undefined,
): Promise<string | null> {
  if (!regionId) {
    // Multi-region scheduler: prefer manual bank (Revolut) when any SA uses it.
    const { data: areas } = await supabase
      .from("service_areas")
      .select("payment_provider, driver_payout_gateway, customer_payment_gateway")
      .limit(50);
    let fallback: string | null = null;
    for (const area of areas ?? []) {
      const provider = providerFromServiceArea(area);
      if (!provider) continue;
      if (isManualBankPayoutProvider(provider)) return provider;
      if (!fallback) fallback = provider;
    }
    return fallback;
  }

  const { data: areas } = await supabase
    .from("service_areas")
    .select("payment_provider, driver_payout_gateway, customer_payment_gateway")
    .eq("region_id", regionId)
    .limit(20);

  for (const area of areas ?? []) {
    const provider = providerFromServiceArea(area);
    if (provider) return provider;
  }

  return null;
}

export async function driverHasActivePayoutDestination(
  supabase: SupabaseClient,
  driverId: string,
  provider: string,
): Promise<boolean> {
  const { data } = await supabase
    .from("driver_payout_destinations")
    .select("id")
    .eq("driver_id", driverId)
    .eq("provider", provider)
    .eq("is_active", true)
    .is("archived_at", null)
    .maybeSingle();

  return Boolean(data?.id);
}

export const PENDING_PAYOUT_ITEM_STATUSES = new Set([
  "pending",
  "processing",
  "ready",
  "transfer_created",
]);

export function normalizeProviderReference(reference: string): string {
  return reference.trim();
}

export function isValidProviderReference(reference: string): boolean {
  const normalized = normalizeProviderReference(reference);
  return normalized.length >= 3 && normalized.length <= 128;
}
