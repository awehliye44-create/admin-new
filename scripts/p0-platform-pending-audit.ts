#!/usr/bin/env npx tsx
/** P0 audit — Platform Stripe Pending vs driver wallet vs Trips tab */
import { createClient } from '@supabase/supabase-js';
import { execSync } from 'node:child_process';

const PROJECT_REF = 'thazislrdkjpvvghtvzo';
const MK_REGION = '7f611e59-a9e5-42c2-b65a-61376910bb5d';

async function main() {
  const url = `https://${PROJECT_REF}.supabase.co`;
  const keys = JSON.parse(execSync(`supabase projects api-keys --project-ref ${PROJECT_REF} -o json`, { encoding: 'utf8' }));
  const anon = keys.find((k: { name: string }) => k.name === 'anon').api_key as string;
  const service = keys.find((k: { name: string }) => k.name === 'service_role').api_key as string;
  const admin = createClient(url, service);

  const { data: link } = await admin.auth.admin.generateLink({ type: 'magiclink', email: 'admin@onecab.net' });
  const client = createClient(url, anon);
  const { data: session } = await client.auth.verifyOtp({
    type: 'magiclink',
    token_hash: link!.properties!.hashed_token,
  });
  const token = session!.session!.access_token;

  const from = '2026-06-01';
  const to = '2026-07-05';
  const frQs = new URLSearchParams({
    region_id: MK_REGION,
    from: `${from}T00:00:00.000Z`,
    to: `${to}T23:59:59.999Z`,
    audit_limit: '10000',
  });
  const frRes = await fetch(`${url}/functions/v1/admin-finance-reconciliation?${frQs}`, {
    headers: { Authorization: `Bearer ${token}`, apikey: anon },
  });
  const fr = await frRes.json();

  const [{ data: era }, { data: drivers }, { data: pendingPay }] = await Promise.all([
    admin.from('admin_settings').select('setting_value').eq('setting_key', 'finance_era').maybeSingle(),
    admin
      .from('driver_financial_summary')
      .select('driver_id, wallet_balance, available_for_payout, net_available_for_payout, drivers(driver_code, first_name, last_name)')
      .eq('region_id', MK_REGION)
      .gt('wallet_balance', 0)
      .order('wallet_balance', { ascending: false })
      .limit(10),
    admin
      .from('payments')
      .select('trip_id, captured_amount_pence, amount_pence, status, provider_status, stripe_payment_intent_id')
      .in('status', ['authorized', 'pending', 'requires_capture', 'requires_payment_method'])
      .limit(30),
  ]);

  const provider = fr.finance_reconciliation_summary?.provider_money;
  const pendingPence = provider?.provider_pending_balance_pence ?? 0;
  const availablePence = provider?.provider_available_balance_pence ?? 0;

  console.log(JSON.stringify({
    finance_era: era?.setting_value ?? null,
    platform_stripe_pending_gbp: (pendingPence / 100).toFixed(2),
    platform_stripe_available_gbp: (availablePence / 100).toFixed(2),
    fr_trips_tab_count: fr.trip_financial_audit?.length ?? 0,
    fr_meta_trip_count: fr.meta?.trip_count,
    driver_wallets_positive: (drivers ?? []).map((d) => ({
      code: (d.drivers as { driver_code?: string })?.driver_code,
      wallet_gbp: (Number(d.wallet_balance) / 100).toFixed(2),
      available_gbp: (Number(d.available_for_payout) / 100).toFixed(2),
    })),
    uncaptured_or_pending_payments: (pendingPay ?? []).length,
    pending_payment_sample: (pendingPay ?? []).slice(0, 5),
    stripe_balance_error: fr.meta?.stripe_balance_error ?? null,
    explanation: {
      platform_pending: 'Stripe balance.retrieve().pending for platform account — not driver Connect balances',
      driver_weekly: 'From driver_wallet_ledger + payout cycle SSOT (finance-reconciliation-driver)',
      next_weekly_zero: 'scheduled_payout_available_pence=0 when no payout batch queued or funds awaiting settlement',
      trips_zero: 'Date range today-only or before date-normalization fix; widen range to see trips',
    },
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
