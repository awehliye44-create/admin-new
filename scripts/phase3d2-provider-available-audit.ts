#!/usr/bin/env node
/**
 * Phase 3D.2 — Provider Available read-only audit (no writes).
 */
import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'fs';
import { join } from 'path';

const MK_REGION = '7f611e59-a9e5-42c2-b65a-61376910bb5d';
const MK0001 = '5ed232c3-8bb5-4085-95d6-73e48e6c5e28';
const MK0002 = 'cd8bae4c-3827-4b90-98c6-10be70eb0e52';

const WALLET_EXCL = new Set(['PLATFORM_COMMISSION', 'CASH_TRIP_EARNING']);

function gbp(p: number): string {
  return `£${(p / 100).toFixed(2)}`;
}

function sumWallet(rows: Array<{ type: string; amount_pence: number }>): number {
  return rows.reduce((s, r) => (WALLET_EXCL.has(r.type) ? s : s + (r.amount_pence ?? 0)), 0);
}

async function getAdminToken(
  admin: ReturnType<typeof createClient>,
  url: string,
  anon: string,
): Promise<string> {
  const { data: link, error } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: 'admin@onecab.net',
  });
  if (error || !link?.properties?.hashed_token) throw new Error(error?.message ?? 'link failed');
  const client = createClient(url, anon);
  const { data: session, error: otpErr } = await client.auth.verifyOtp({
    type: 'magiclink',
    token_hash: link.properties.hashed_token,
  });
  if (otpErr || !session.session?.access_token) throw new Error(otpErr?.message ?? 'session failed');
  return session.session.access_token;
}

async function invokeGet(
  url: string,
  anon: string,
  token: string,
  name: string,
  query: string,
): Promise<unknown> {
  const res = await fetch(`${url}/functions/v1/${name}?${query}`, {
    headers: { Authorization: `Bearer ${token}`, apikey: anon },
  });
  return res.json();
}

async function main() {
  const url = process.env.SUPABASE_URL!;
  const anon = process.env.SUPABASE_ANON_KEY!;
  const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const token = await getAdminToken(admin, url, anon);

  const today = new Date().toISOString().slice(0, 10);
  const allTimeFrom = '2020-01-01T00:00:00.000Z';
  const allTimeTo = '2030-12-31T23:59:59.999Z';

  const financeToday = await invokeGet(
    url, anon, token, 'admin-finance-reconciliation',
    `region_id=${MK_REGION}&from=${today}T00:00:00.000Z&to=${today}T23:59:59.999Z`,
  ) as Record<string, unknown>;

  const financeAll = await invokeGet(
    url, anon, token, 'admin-finance-reconciliation',
    `region_id=${MK_REGION}&from=${allTimeFrom}&to=${allTimeTo}`,
  ) as Record<string, unknown>;

  const auditAll = await invokeGet(
    url, anon, token, 'finance-backend-audit-v1',
    `region_id=${MK_REGION}&from=${allTimeFrom}&to=${allTimeTo}`,
  ) as Record<string, unknown>;

  const finance = financeToday;

  const { data: ledgerAll } = await admin
    .from('driver_wallet_ledger')
    .select('driver_id, type, amount_pence, stripe_transfer_id, stripe_payout_id, created_at')
    .in('driver_id', [MK0001, MK0002])
    .order('created_at', { ascending: false });

  const { data: payoutsToday } = await admin
    .from('payout_items')
    .select('id, driver_id, amount_pence, status, stripe_transfer_id, stripe_payout_id, created_at, completed_at')
    .gte('created_at', `${today}T00:00:00.000Z`)
    .order('created_at', { ascending: false });

  const { data: drivers } = await admin
    .from('driver_financial_summary')
    .select('driver_id, wallet_balance, card_net_credits, amount_owed_to_onecab, total_payouts_sent')
    .eq('region_id', MK_REGION);

  const summary = finance.finance_reconciliation_summary as Record<string, Record<string, number>> | undefined;
  const summaryAll = (financeAll.finance_reconciliation_summary ?? {}) as Record<string, Record<string, number>>;
  const provider = summary?.provider_money;
  const driverMoney = summary?.driver_money;
  const recon = summary?.reconciliation_check;
  const incoming = (auditAll.incoming_money ?? {}) as Record<string, number>;
  const remaining = (auditAll.remaining_money ?? {}) as Record<string, number>;
  const paidOut = (auditAll.paid_out ?? {}) as Record<string, number>;
  const auditAnswered = auditAll.answered_questions;
  const auditWalletIntegrity = auditAll.wallet_integrity;

  const mk1Ledger = (ledgerAll ?? []).filter((r) => r.driver_id === MK0001);
  const mk2Ledger = (ledgerAll ?? []).filter((r) => r.driver_id === MK0002);

  const report = {
    phase: '3D.2',
    timestamp: new Date().toISOString(),
    region_id: MK_REGION,
    provider_available: {
      pence: provider?.provider_available_balance_pence ?? incoming.provider_available_balance_pence,
      gbp: gbp(provider?.provider_available_balance_pence ?? incoming.provider_available_balance_pence ?? 0),
      pending_pence: provider?.provider_pending_balance_pence ?? incoming.provider_pending_balance_pence,
      pending_gbp: gbp(provider?.provider_pending_balance_pence ?? incoming.provider_pending_balance_pence ?? 0),
      source: 'stripe.balance.retrieve() → balance.available[gbp] (platform account)',
      query_location: 'admin-finance-reconciliation/index.ts lines 315-322',
    },
    reconciliation_summary: {
      remaining_liability_pence: recon?.driver_remaining_liability_pence ?? remaining.driver_remaining_liability_pence,
      driver_available_now_pence: driverMoney?.driver_available_payout_pence ?? remaining.driver_available_now_pence,
      driver_paid_out_pence: driverMoney?.driver_paid_out_pence ?? paidOut.driver_paid_out_total_pence,
      reconciliation_status: recon?.status,
      balanced: recon?.balanced,
      card_payable_pence: driverMoney?.card_driver_payable_pence,
      wallet_aggregate_pence: driverMoney?.driver_wallet_balance_pence,
    },
    drivers: (drivers ?? []).map((d) => ({
      driver_id: d.driver_id,
      wallet_pence: d.wallet_balance,
      wallet_gbp: gbp(Number(d.wallet_balance ?? 0)),
      ledger_ssot_pence: sumWallet(
        (ledgerAll ?? []).filter((r) => r.driver_id === d.driver_id) as Array<{ type: string; amount_pence: number }>,
      ),
      card_net_credits_pence: d.card_net_credits,
      cash_owed_pence: d.amount_owed_to_onecab,
      total_payouts_sent_pence: d.total_payouts_sent,
    })),
    payout_items_today: payoutsToday,
    mk0001_recent_ledger: mk1Ledger.slice(0, 15),
    mk0002_recent_ledger: mk2Ledger.slice(0, 10),
    audit_answered: auditAnswered,
    audit_wallet_integrity: auditWalletIntegrity,
    all_time_reconciliation: {
      card_customer_revenue_pence: summaryAll.customer_revenue?.card_customer_revenue_pence,
      card_driver_payable_pence: summaryAll.driver_money?.card_driver_payable_pence,
      onecab_card_commission_pence: summaryAll.onecab_money?.onecab_card_commission_pence,
      onecab_net_commission_pence: summaryAll.onecab_money?.net_platform_revenue_pence,
      driver_paid_out_pence: summaryAll.driver_money?.driver_paid_out_pence,
      remaining_liability_pence: summaryAll.reconciliation_check?.driver_remaining_liability_pence,
      driver_available_now_pence: summaryAll.driver_money?.driver_available_payout_pence,
      wallet_aggregate_pence: summaryAll.driver_money?.driver_wallet_balance_pence,
      reconciliation_status: summaryAll.reconciliation_check?.status,
    },
  };

  const outPath = join(process.cwd(), 'docs/phase3d2-provider-available-audit-output.json');
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
