import type { DriverWalletSsotRow } from '@/hooks/useDriverWalletSsot';

export type StripeAccountDisplayStatus =
  | 'Connected'
  | 'Pending verification'
  | 'Restricted'
  | 'Disconnected';

export function resolveStripeAccountStatus(args: {
  connectedAccountId?: string | null;
  chargesEnabled?: boolean | null;
  payoutsEnabled?: boolean | null;
  detailsSubmitted?: boolean | null;
  connectAccountStatus?: string | null;
}): StripeAccountDisplayStatus {
  if (!args.connectedAccountId) return 'Disconnected';
  const status = String(args.connectAccountStatus ?? '').toLowerCase();
  if (status.includes('pending') || args.detailsSubmitted === false) {
    return 'Pending verification';
  }
  if (args.chargesEnabled === false || args.payoutsEnabled === false) {
    return 'Restricted';
  }
  if (args.chargesEnabled && args.payoutsEnabled) return 'Connected';
  return 'Pending verification';
}

/** Driver money on overview — Stripe balance.available only. */
export function driverStripeAvailablePence(
  driver: DriverWalletSsotRow | null | undefined,
): number | null {
  if (!driver?.connected_account_id) return null;
  if (typeof driver.stripe_connect_available_pence !== 'number') return null;
  return Math.max(0, driver.stripe_connect_available_pence);
}

/** Stripe balance.pending — not driver-facing spendable money. */
export function driverStripePendingPence(
  driver: DriverWalletSsotRow | null | undefined,
): number | null {
  if (!driver?.connected_account_id) return null;
  if (typeof driver.stripe_connect_pending_pence !== 'number') return null;
  return Math.max(0, driver.stripe_connect_pending_pence);
}

/** Next weekly transfer display — Stripe available only (no ledger/batch fallback). */
export function driverNextWeeklyTransferPence(
  driver: DriverWalletSsotRow | null | undefined,
): number | null {
  return driverStripeAvailablePence(driver);
}

export function driverLastStripePayout(driver: DriverWalletSsotRow | null | undefined): {
  payoutId: string | null;
  amountPence: number | null;
  at: string | null;
} {
  if (!driver) {
    return { payoutId: null, amountPence: null, at: null };
  }

  const rows = [...(driver.stripe_connect_payouts ?? [])].sort((a, b) => {
    const aTs = new Date(String(a.initiated_at ?? a.arrival_date ?? 0)).getTime();
    const bTs = new Date(String(b.initiated_at ?? b.arrival_date ?? 0)).getTime();
    return bTs - aTs;
  });

  const latest = rows[0] as Record<string, unknown> | undefined;
  if (latest) {
    return {
      payoutId: latest.payout_id ? String(latest.payout_id) : null,
      amountPence: typeof latest.amount_pence === 'number'
        ? Math.max(0, Number(latest.amount_pence))
        : driver.last_payout_amount_pence,
      at: String(latest.initiated_at ?? latest.arrival_date ?? driver.last_payout_at ?? '') || null,
    };
  }

  return {
    payoutId: null,
    amountPence: driver.last_payout_amount_pence,
    at: driver.last_payout_at,
  };
}
