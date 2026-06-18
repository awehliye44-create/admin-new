#!/usr/bin/env node
/**
 * Phase 3C.3e production verification — read-only / dry-run only.
 * Requires: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY
 */
import { createClient } from '@supabase/supabase-js';

const MK_REGION = '7f611e59-a9e5-42c2-b65a-61376910bb5d';
const DRIVERS = [
  { code: 'MK0001', id: '5ed232c3-8bb5-4085-95d6-73e48e6c5e28' },
  { code: 'MK0002', id: 'cd8bae4c-3827-4b90-98c6-10be70eb0e52' },
] as const;

const WALLET_EXCL = new Set(['PLATFORM_COMMISSION', 'CASH_TRIP_EARNING']);

function gbp(p: number): string {
  return `£${(p / 100).toFixed(2)}`;
}

function sumLedger(
  rows: Array<{ type: string; amount_pence: number }>,
  excl: Set<string>,
): number {
  return rows.reduce((s, r) => (excl.has(r.type) ? s : s + (r.amount_pence ?? 0)), 0);
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
  if (error || !link?.properties?.hashed_token) {
    throw new Error(`admin link failed: ${error?.message}`);
  }
  const client = createClient(url, anon);
  const { data: session, error: otpErr } = await client.auth.verifyOtp({
    type: 'magiclink',
    token_hash: link.properties.hashed_token,
  });
  if (otpErr || !session.session?.access_token) {
    throw new Error(`admin session failed: ${otpErr?.message}`);
  }
  return session.session.access_token;
}

async function invokeAdmin(
  url: string,
  anon: string,
  token: string,
  name: string,
  opts: { method?: string; body?: unknown; query?: string },
): Promise<{ status: number; data: unknown }> {
  const qs = opts.query ? `?${opts.query}` : '';
  const res = await fetch(`${url}/functions/v1/${name}${qs}`, {
    method: opts.method ?? 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: anon,
      'Content-Type': 'application/json',
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

async function main() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anon = process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !serviceKey || !anon) {
    console.error('Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY');
    process.exit(1);
  }

  const admin = createClient(url, serviceKey);
  const token = await getAdminToken(admin, url, anon);

  console.log('# Phase 3C.3e Production Verification\n');
  console.log(`Project: ${url}\n`);

  const report: Record<string, unknown> = {
    wallet_mismatch: [],
    drivers: {} as Record<string, unknown>,
    weekly_dry_run: null as unknown,
    payout_dry_run: {} as Record<string, unknown>,
    blockers: [] as string[],
  };

  for (const d of DRIVERS) {
    const { data: dfs } = await admin
      .from('driver_financial_summary')
      .select('wallet_balance, amount_owed_to_onecab, card_net_credits, company_commission_total, payouts_enabled, stripe_account_id, onboarding_complete')
      .eq('driver_id', d.id)
      .maybeSingle();

    const { data: ledger } = await admin
      .from('driver_wallet_ledger')
      .select('type, amount_pence')
      .eq('driver_id', d.id);

    const rows = ledger ?? [];
    const ledgerWallet = sumLedger(rows, WALLET_EXCL);
    const adminDisplayed = Number(dfs?.wallet_balance ?? 0);

    const finance = await invokeAdmin(url, anon, token, 'admin-finance-reconciliation', {
      method: 'GET',
      query: `driver_id=${d.id}&region_id=${MK_REGION}`,
    });

    const driverWallet = await admin
      .from('drivers')
      .select('user_id')
      .eq('id', d.id)
      .maybeSingle();

    let driverAppWallet: number | null = null;
    if (driverWallet.data?.user_id) {
      const { data: u } = await admin.auth.admin.getUserById(driverWallet.data.user_id);
      if (u?.user?.email) {
        const { data: dlink } = await admin.auth.admin.generateLink({
          type: 'magiclink',
          email: u.user.email,
        });
        if (dlink?.properties?.hashed_token) {
          const dclient = createClient(url, anon);
          const { data: ds } = await dclient.auth.verifyOtp({
            type: 'magiclink',
            token_hash: dlink.properties.hashed_token,
          });
          if (ds.session?.access_token) {
            const wres = await fetch(`${url}/functions/v1/driver-wallet-summary`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${ds.session.access_token}`,
                apikey: anon,
                'Content-Type': 'application/json',
              },
              body: '{}',
            });
            if (wres.ok) {
              const w = await wres.json();
              driverAppWallet = Number(w.net_balance_pence ?? w.available_payout_pence ?? 0);
            }
          }
        }
      }
    }

    const ssot = (finance.data as { finance_reconciliation_driver_ssot?: Record<string, unknown> })
      ?.finance_reconciliation_driver_ssot;

    const walletMatch = adminDisplayed === ledgerWallet;
    if (!walletMatch) {
      (report.blockers as string[]).push(
        `${d.code}: admin wallet ${adminDisplayed}p != ledger SSOT ${ledgerWallet}p`,
      );
    }

    report.drivers[d.code] = {
      driver_id: d.id,
      admin_displayed_wallet_pence: adminDisplayed,
      admin_displayed_wallet: gbp(adminDisplayed),
      ledger_ssot_wallet_pence: ledgerWallet,
      ledger_ssot_wallet: gbp(ledgerWallet),
      driver_app_wallet_pence: driverAppWallet,
      driver_app_wallet: driverAppWallet != null ? gbp(driverAppWallet) : null,
      wallet_ssot_match: walletMatch,
      driver_app_vs_ssot_match: driverAppWallet === ledgerWallet,
      finance_ssot: ssot
        ? {
            driver_available_now_pence: ssot.driver_available_now_pence,
            driver_pending_payout_pence: ssot.driver_pending_payout_pence,
            driver_remaining_liability_pence: ssot.driver_remaining_liability_pence,
            payout_blocked: ssot.payout_blocked,
            payout_blocked_reasons: ssot.payout_blocked_reasons,
            payout_warning_reasons: ssot.payout_warning_reasons,
            reconciliation_status: ssot.reconciliation_status,
            provider_allocated_pence: ssot.provider_available_balance_allocated_to_driver_pence,
          }
        : { error: finance.status, raw: finance.data },
    };
  }

  // READ-ONLY: do NOT invoke settlement or payout on production — deployed edges may execute Stripe.
  report.weekly_dry_run = {
    skipped: true,
    reason: 'Production admin-weekly-monday-settlement has no dry_run gate; invocation creates real batches.',
  };
  report.payout_dry_run = {
    skipped: true,
    reason: 'Production admin-driver-payout executes real Stripe transfers without ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED.',
  };

  const failedItems = await admin
    .from('payout_items')
    .select('id, driver_id, status, failure_code, failure_reason, stripe_transfer_id')
    .in('driver_id', DRIVERS.map((x) => x.id))
    .in('status', ['failed', 'ledger_sync_failed'])
    .limit(10);

  report.failed_payout_items = failedItems.data;

  const financeRegion = await invokeAdmin(url, anon, token, 'admin-finance-reconciliation', {
    method: 'GET',
    query: `region_id=${MK_REGION}`,
  });
  const summary = (financeRegion.data as { finance_reconciliation_summary?: { onecab_money?: Record<string, unknown> } })
    ?.finance_reconciliation_summary?.onecab_money;

  report.commission_visibility = summary
    ? {
        onecab_gross_commission_pence: summary.onecab_gross_commission_pence,
        provider_processing_fee_pence: summary.provider_processing_fee_pence,
        onecab_net_commission_pence: summary.onecab_net_commission_pence,
        onecab_cash_commission_receivable_pence: summary.onecab_cash_commission_receivable_pence,
        onecab_bank_payout_pence: summary.onecab_bank_payout_pence,
        onecab_commission_status_label: summary.onecab_commission_status_label,
      }
    : { error: financeRegion.status };

  console.log(JSON.stringify(report, null, 2));

  const blockers = report.blockers as string[];
  if (blockers.length > 0) {
    console.error('\n## BLOCKERS\n');
    blockers.forEach((b) => console.error(`- ${b}`));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
