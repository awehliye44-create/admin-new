#!/usr/bin/env node
/**
 * Phase 3D — Final payout readiness verification (read-only + safe dry-runs).
 */
import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'fs';
import { join } from 'path';

const MK_REGION = '7f611e59-a9e5-42c2-b65a-61376910bb5d';
const DRIVERS = [
  { code: 'MK0001', id: '5ed232c3-8bb5-4085-95d6-73e48e6c5e28', expectedWallet: 87 },
  { code: 'MK0002', id: 'cd8bae4c-3827-4b90-98c6-10be70eb0e52', expectedWallet: -2300 },
] as const;

const WALLET_EXCL = new Set(['PLATFORM_COMMISSION', 'CASH_TRIP_EARNING']);

function gbp(p: number): string {
  return `£${(p / 100).toFixed(2)}`;
}

function sumLedger(rows: Array<{ type: string; amount_pence: number }>): number {
  return rows.reduce(
    (s, r) => (WALLET_EXCL.has(r.type) ? s : s + (r.amount_pence ?? 0)),
    0,
  );
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

async function getDriverAppWallet(
  admin: ReturnType<typeof createClient>,
  url: string,
  anon: string,
  driverId: string,
): Promise<number | null> {
  const { data: row } = await admin
    .from('drivers')
    .select('user_id')
    .eq('id', driverId)
    .maybeSingle();
  if (!row?.user_id) return null;
  const { data: u } = await admin.auth.admin.getUserById(row.user_id);
  if (!u?.user?.email) return null;
  const { data: dlink } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: u.user.email,
  });
  if (!dlink?.properties?.hashed_token) return null;
  const dclient = createClient(url, anon);
  const { data: ds } = await dclient.auth.verifyOtp({
    type: 'magiclink',
    token_hash: dlink.properties.hashed_token,
  });
  if (!ds.session?.access_token) return null;
  const wres = await fetch(`${url}/functions/v1/driver-wallet-summary`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${ds.session.access_token}`,
      apikey: anon,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  if (!wres.ok) return null;
  const w = (await wres.json()) as { net_balance_pence?: number };
  return Number(w.net_balance_pence ?? NaN);
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
  const blockers: string[] = [];
  const warnings: string[] = [];

  const report: Record<string, unknown> = {
    phase: '3D',
    date: new Date().toISOString().slice(0, 10),
    project: url,
    ssot_comparison: {} as Record<string, unknown>,
    historical_cleanup: {} as Record<string, unknown>,
    dry_runs: {} as Record<string, unknown>,
    safety_gates: {} as Record<string, unknown>,
    blockers: [] as string[],
    warnings: [] as string[],
    go_live_first_controlled_payout: 'NO-GO',
  };

  // --- SSOT comparison ---
  for (const d of DRIVERS) {
    const { data: dfs } = await admin
      .from('driver_financial_summary')
      .select(
        'wallet_balance, net_available_for_payout, available_for_payout, amount_owed_to_onecab',
      )
      .eq('driver_id', d.id)
      .maybeSingle();

    const { data: cache } = await admin
      .from('driver_wallets')
      .select('available_pence')
      .eq('driver_id', d.id)
      .maybeSingle();

    const { data: ledger } = await admin
      .from('driver_wallet_ledger')
      .select('type, amount_pence')
      .eq('driver_id', d.id);

    const ledgerWallet = sumLedger(ledger ?? []);
    const adminWallet = Number(dfs?.wallet_balance ?? 0);
    const driverAppWallet = await getDriverAppWallet(admin, url, anon, d.id);

    const finance = await invokeAdmin(url, anon, token, 'admin-finance-reconciliation', {
      method: 'GET',
      query: `driver_id=${d.id}&region_id=${MK_REGION}`,
    });
    const perDriver = (finance.data as { finance_reconciliation_driver_ssot?: Record<string, unknown> })
      ?.finance_reconciliation_driver_ssot;

    if (adminWallet !== ledgerWallet) {
      blockers.push(`${d.code}: admin wallet ${adminWallet}p != ledger ${ledgerWallet}p`);
    }
    if (adminWallet !== d.expectedWallet && d.code === 'MK0001' && adminWallet === 0) {
      warnings.push(`${d.code}: wallet 0p after verification incident (expected was ${d.expectedWallet}p)`);
    } else if (adminWallet !== d.expectedWallet) {
      blockers.push(`${d.code}: wallet ${adminWallet}p != expected ${d.expectedWallet}p`);
    }
    if (driverAppWallet != null && driverAppWallet !== ledgerWallet) {
      blockers.push(`${d.code}: driver app ${driverAppWallet}p != ledger ${ledgerWallet}p`);
    }
    if (Number(cache?.available_pence ?? -1) !== ledgerWallet) {
      warnings.push(`${d.code}: driver_wallets cache ${cache?.available_pence}p != ledger ${ledgerWallet}p`);
    }

    (report.ssot_comparison as Record<string, unknown>)[d.code] = {
      expected_wallet_pence: d.expectedWallet,
      expected_wallet: gbp(d.expectedWallet),
      ledger_ssot_pence: ledgerWallet,
      admin_settlements_pence: adminWallet,
      driver_app_net_balance_pence: driverAppWallet,
      driver_wallets_cache_pence: cache?.available_pence ?? null,
      finance_driver_ssot: perDriver
        ? {
            driver_remaining_liability_pence: perDriver.driver_remaining_liability_pence,
            driver_available_now_pence: perDriver.driver_available_now_pence,
            payout_blocked: perDriver.payout_blocked,
            payout_blocked_reasons: perDriver.payout_blocked_reasons,
            payout_warning_reasons: perDriver.payout_warning_reasons,
            reconciliation_status: perDriver.reconciliation_status,
          }
        : { error: finance.status },
      all_wallet_sources_match: adminWallet === ledgerWallet && (driverAppWallet == null || driverAppWallet === ledgerWallet),
    };
  }

  // Region finance summary
  const financeRegion = await invokeAdmin(url, anon, token, 'admin-finance-reconciliation', {
    method: 'GET',
    query: `region_id=${MK_REGION}`,
  });
  const summary = (financeRegion.data as {
    finance_reconciliation_summary?: {
      driver_money?: Record<string, unknown>;
      reconciliation_check?: Record<string, unknown>;
    };
  })?.finance_reconciliation_summary;

  report.region_finance = {
    driver_wallet_balance_pence: summary?.driver_money?.driver_wallet_balance_pence,
    driver_wallet_balance: gbp(Number(summary?.driver_money?.driver_wallet_balance_pence ?? 0)),
    reconciliation_status: summary?.reconciliation_check?.status,
    reconciliation_balanced: summary?.reconciliation_check?.balanced,
  };

  // Finance backend audit
  const backendAudit = await invokeAdmin(url, anon, token, 'finance-backend-audit-v1', {
    method: 'GET',
    query: `region_id=${MK_REGION}`,
  });
  report.finance_backend_audit = {
    status: backendAudit.status,
    wallet_integrity: (backendAudit.data as { wallet_integrity?: unknown[] })?.wallet_integrity?.slice(0, 5),
    payout_audit_rows: (backendAudit.data as { payout_audit_rows?: unknown[] })?.payout_audit_rows?.slice(0, 8),
  };

  // Monday diagnostics
  const monday = await invokeAdmin(url, anon, token, 'admin-monday-payout-diagnostics', {
    method: 'GET',
    query: `region_id=${MK_REGION}&today=false`,
  });
  report.monday_diagnostics = {
    mismatches: ((monday.data as { monday_payout_diagnostics?: Array<{ reconciliation_status: string }> })
      ?.monday_payout_diagnostics ?? []).filter((r) => r.reconciliation_status === 'RECONCILIATION_MISMATCH').length,
    cards: (monday.data as { monday_payout_today_cards?: unknown })?.monday_payout_today_cards,
  };

  // --- Historical cleanup ---
  const { data: dupItem } = await admin
    .from('payout_items')
    .select('status, amount_pence')
    .eq('id', 'c5bcd2f7-36f6-44ba-a36d-9822ac32ed44')
    .maybeSingle();
  const { data: realItem } = await admin
    .from('payout_items')
    .select('status, ledger_entry_id, stripe_payout_id')
    .eq('id', '2c50b7df-dcae-40be-9888-f89f061e0f4b')
    .maybeSingle();
  const { data: mk1po } = await admin
    .from('driver_wallet_ledger')
    .select('amount_pence')
    .eq('stripe_payout_id', 'po_1TjTPXEXTz9Ab5IcE2GFPiaq')
    .maybeSingle();
  const { data: mk2po } = await admin
    .from('driver_wallet_ledger')
    .select('amount_pence')
    .eq('stripe_payout_id', 'po_1TjUCpIzd0dzmC0Y65sJxUHu')
    .maybeSingle();
  const { data: reconNote } = await admin
    .from('finance_reconciliation_notes')
    .select('*')
    .eq('stripe_payout_id', 'po_1TjUCpIzd0dzmC0Y65sJxUHu')
    .maybeSingle();

  report.historical_cleanup = {
    duplicate_457_resolved: dupItem?.status === 'FAILED_DUPLICATE',
    manual_457_linked: realItem?.status === 'completed' && !!realItem?.ledger_entry_id,
    mk0001_po_1TjTPX_backfill_pence: mk1po?.amount_pence ?? null,
    mk0002_po_1TjUCp_ledger_debit_pence: mk2po?.amount_pence ?? null,
    mk0002_operational_loss_pence: reconNote?.operational_loss_pence ?? null,
    mk0002_stripe_explained:
      mk2po?.amount_pence === -4201 &&
      reconNote?.operational_loss_pence === 1440 &&
      reconNote?.stripe_payout_amount_pence === 5641,
    bank_943_status: 'UNMATCHED — documented in PHASE_3C4/3C5; no ledger invented',
  };

  if (dupItem?.status !== 'FAILED_DUPLICATE') blockers.push('Duplicate £4.57 not FAILED_DUPLICATE');
  if (mk1po?.amount_pence !== -1693) blockers.push('MK0001 po_1TjTPX backfill missing');
  if (mk2po?.amount_pence !== -4201) blockers.push('MK0002 partial debit missing');
  if (reconNote?.operational_loss_pence !== 1440) blockers.push('MK0002 operational loss note missing');

  // --- Dry runs SKIPPED on prod (pre-3C.3e edges execute Stripe / DB writes) ---
  report.dry_runs = {
    skipped_live_invocation: true,
    reason: 'Prod admin-driver-payout v178 and admin-weekly-monday-settlement v4 lack 3C.3e gates',
    documented_run_2026_06_18: {
      weekly_monday: {
        dry_run_honoured: false,
        batch_created: '8819ebee-cb96-406f-9f30-035baac119c5',
        orphan_item: '0c12e3dc-a8e9-4331-8080-2a5c713d4e9a (307p pending)',
      },
      manual_mk0001: {
        unintended_stripe_transfer: 'tr_1TjdMjEeK1Cb9ZBxVHEeUaii',
        ledger_debit_pence: -87,
        wallet_after: 0,
      },
      manual_mk0002: { blocked: true, error_code: 'MANUAL_PAYOUT_RECONCILIATION_MISMATCH' },
    },
  };

  report.safety_gates = {
    ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED: 'Must remain false/unset until Ahmed approves',
    prod_deployed: false,
    repo_code_gate_present: true,
    deployed_versions: {
      'admin-driver-payout': 'v178 (2026-06-15)',
      'admin-weekly-monday-settlement': 'v4 (2026-06-15)',
    },
  };

  blockers.push('3C.3e payout edges not deployed — dry-run / execution gates absent on prod');

  // Payout eligibility summary
  report.payout_eligibility = {
    MK0001: (report.ssot_comparison as Record<string, Record<string, unknown>>).MK0001?.finance_driver_ssot,
    MK0002: (report.ssot_comparison as Record<string, Record<string, unknown>>).MK0002?.finance_driver_ssot,
  };

  report.blockers = blockers;
  report.warnings = warnings;
  report.go_live_first_controlled_payout =
    blockers.length === 0 ? 'NO-GO — Ahmed explicit approval required' : 'NO-GO';

  const outPath = join(process.cwd(), 'docs/phase3d-verification-output.json');
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`\nWrote ${outPath}`);

  if (blockers.length) {
    console.error('\n## BLOCKERS\n');
    blockers.forEach((b) => console.error(`- ${b}`));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
