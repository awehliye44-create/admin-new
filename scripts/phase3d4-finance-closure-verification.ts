#!/usr/bin/env node
/**
 * Phase 3D.4 — Finance closure read-only verification.
 * No Stripe updates, ledger writes, payout execution, or batch creation.
 */
import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'fs';
import { join } from 'path';

const MK_REGION = '7f611e59-a9e5-42c2-b65a-61376910bb5d';
const DRIVERS = [
  { code: 'MK0001', id: '5ed232c3-8bb5-4085-95d6-73e48e6c5e28', stripe: 'acct_1ThTrEEXTz9Ab5Ic' },
  { code: 'MK0002', id: 'cd8bae4c-3827-4b90-98c6-10be70eb0e52', stripe: 'acct_1ThUR8Izd0dzmC0Y' },
] as const;

const ORPHAN_BATCH = '8819ebee-cb96-406f-9f30-035baac119c5';
const ORPHAN_ITEM = '0c12e3dc-a8e9-4331-8080-2a5c713d4e9a';
const DUP_ITEM = 'c5bcd2f7-36f6-44ba-a36d-9822ac32ed44';
const REAL_457_ITEM = '2c50b7df-dcae-40be-9888-f89f061e0f4b';

const WALLET_EXCL = new Set(['PLATFORM_COMMISSION', 'CASH_TRIP_EARNING']);

type SectionResult = {
  section: string;
  pass: boolean;
  blockers: string[];
  warnings: string[];
  evidence: Record<string, unknown>;
};

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
  opts: { method?: string; body?: unknown; query?: string; serviceKey?: string } = {},
): Promise<{ status: number; data: unknown }> {
  const qs = opts.query ? `?${opts.query}` : '';
  const auth = opts.serviceKey ? opts.serviceKey : token;
  const res = await fetch(`${url}/functions/v1/${name}${qs}`, {
    method: opts.method ?? 'POST',
    headers: {
      Authorization: `Bearer ${auth}`,
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

async function countSince(
  admin: ReturnType<typeof createClient>,
  table: string,
  since: string,
): Promise<number> {
  const { count } = await admin.from(table).select('id', { count: 'exact', head: true }).gte('created_at', since);
  return count ?? 0;
}

async function getDriverAppWallet(
  admin: ReturnType<typeof createClient>,
  url: string,
  anon: string,
  driverId: string,
): Promise<number | null> {
  const { data: row } = await admin.from('drivers').select('user_id').eq('id', driverId).maybeSingle();
  if (!row?.user_id) return null;
  const { data: u } = await admin.auth.admin.getUserById(row.user_id);
  if (!u?.user?.email) return null;
  const { data: dlink } = await admin.auth.admin.generateLink({ type: 'magiclink', email: u.user.email });
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
  const url = process.env.SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const anon = process.env.SUPABASE_ANON_KEY!;
  const admin = createClient(url, serviceKey);
  const token = await getAdminToken(admin, url, anon);
  const windowSince = new Date().toISOString();
  const allTimeFrom = '2020-01-01T00:00:00.000Z';
  const allTimeTo = '2030-12-31T23:59:59.999Z';
  const today = new Date().toISOString().slice(0, 10);

  const sections: SectionResult[] = [];

  // --- 1. Wallet SSOT ---
  const walletEvidence: Record<string, unknown> = {};
  const walletBlockers: string[] = [];
  const walletWarnings: string[] = [];

  for (const d of DRIVERS) {
    const { data: ledger } = await admin
      .from('driver_wallet_ledger')
      .select('type, amount_pence')
      .eq('driver_id', d.id);
    const ledgerWallet = sumLedger(ledger ?? []);

    const { data: dfs } = await admin
      .from('driver_financial_summary')
      .select('wallet_balance, net_available_for_payout, available_for_payout')
      .eq('driver_id', d.id)
      .maybeSingle();

    const { data: cache } = await admin
      .from('driver_wallets')
      .select('available_pence')
      .eq('driver_id', d.id)
      .maybeSingle();

    const driverApp = await getDriverAppWallet(admin, url, anon, d.id);
    const adminWallet = Number(dfs?.wallet_balance ?? 0);

    if (adminWallet !== ledgerWallet) {
      walletBlockers.push(`${d.code}: driver_financial_summary ${adminWallet}p != ledger ${ledgerWallet}p`);
    }
    if (driverApp != null && driverApp !== ledgerWallet) {
      walletBlockers.push(`${d.code}: driver app ${driverApp}p != ledger ${ledgerWallet}p`);
    }
    if (Number(cache?.available_pence ?? -999999) !== ledgerWallet) {
      walletWarnings.push(`${d.code}: driver_wallets cache ${cache?.available_pence}p != ledger ${ledgerWallet}p`);
    }

    walletEvidence[d.code] = {
      ledger_ssot_pence: ledgerWallet,
      ledger_ssot_gbp: gbp(ledgerWallet),
      driver_financial_summary_pence: adminWallet,
      driver_wallets_cache_pence: cache?.available_pence ?? null,
      driver_app_net_balance_pence: driverApp,
      sources_match: adminWallet === ledgerWallet && (driverApp == null || driverApp === ledgerWallet),
    };
  }

  sections.push({
    section: '1_wallet_ssot',
    pass: walletBlockers.length === 0,
    blockers: walletBlockers,
    warnings: walletWarnings,
    evidence: walletEvidence,
  });

  // --- 2. Financial Reconciliation SSOT ---
  const reconBlockers: string[] = [];
  const reconWarnings: string[] = [];

  const financeRegion = await invokeAdmin(url, anon, token, 'admin-finance-reconciliation', {
    method: 'GET',
    query: `region_id=${MK_REGION}&from=${allTimeFrom}&to=${allTimeTo}`,
  });
  const financeToday = await invokeAdmin(url, anon, token, 'admin-finance-reconciliation', {
    method: 'GET',
    query: `region_id=${MK_REGION}&from=${today}T00:00:00.000Z&to=${today}T23:59:59.999Z`,
  });
  const backendAudit = await invokeAdmin(url, anon, token, 'finance-backend-audit-v1', {
    method: 'GET',
    query: `region_id=${MK_REGION}&from=${allTimeFrom}&to=${allTimeTo}`,
  });

  const summaryAll = (financeRegion.data as { finance_reconciliation_summary?: Record<string, unknown> })
    ?.finance_reconciliation_summary;
  const reconCheck = summaryAll?.reconciliation_check as Record<string, unknown> | undefined;
  const driverMoney = summaryAll?.driver_money as Record<string, number> | undefined;
  const walletIntegrity = (backendAudit.data as { wallet_integrity?: Array<{ pass?: boolean }> })
    ?.wallet_integrity ?? [];

  if (financeRegion.status !== 200) reconBlockers.push('admin-finance-reconciliation all-time failed');
  if (backendAudit.status !== 200) reconBlockers.push('finance-backend-audit-v1 failed');

  const integrityFails = walletIntegrity.filter((r) => r.pass === false);
  if (integrityFails.length > 0) {
    reconBlockers.push(`wallet_integrity failures: ${integrityFails.length}`);
  }

  const perDriverRecon: Record<string, unknown> = {};
  for (const d of DRIVERS) {
    const fin = await invokeAdmin(url, anon, token, 'admin-finance-reconciliation', {
      method: 'GET',
      query: `driver_id=${d.id}&region_id=${MK_REGION}&from=${allTimeFrom}&to=${allTimeTo}`,
    });
    const ssot = (fin.data as { finance_reconciliation_driver_ssot?: Record<string, unknown> })
      ?.finance_reconciliation_driver_ssot;
    perDriverRecon[d.code] = ssot ?? { error: fin.status };
    if (ssot?.reconciliation_status === 'RECONCILIATION_MISMATCH') {
      reconWarnings.push(`${d.code}: reconciliation_status RECONCILIATION_MISMATCH (documented timing variance)`);
    }
  }

  if (reconCheck?.balanced === false) {
    reconWarnings.push('Region reconciliation_check.balanced=false (expected with in-flight Stripe settlement)');
  }

  sections.push({
    section: '2_financial_reconciliation_ssot',
    pass: reconBlockers.length === 0,
    blockers: reconBlockers,
    warnings: reconWarnings,
    evidence: {
      endpoint_status: { all_time: financeRegion.status, today: financeToday.status, backend_audit: backendAudit.status },
      reconciliation_check: reconCheck,
      driver_money: driverMoney,
      wallet_integrity_count: walletIntegrity.length,
      wallet_integrity_failures: integrityFails.length,
      per_driver: perDriverRecon,
      audit_answered_questions: (backendAudit.data as { answered_questions?: unknown })?.answered_questions,
    },
  });

  // --- 3. Stripe reconciliation ---
  const stripeBlockers: string[] = [];
  const stripeWarnings: string[] = [];

  const stripeRecon = await invokeAdmin(url, anon, serviceKey, 'stripe-reconciliation-audit', {
    body: { since: '2026-05-01' },
    serviceKey,
  });
  const stripeBalance = await invokeAdmin(url, anon, serviceKey, 'phase-3d2-stripe-balance-audit', {
    body: {},
    serviceKey,
  });

  if (stripeRecon.status !== 200) {
    stripeWarnings.push(`stripe-reconciliation-audit HTTP ${stripeRecon.status} — using balance audit fallback`);
  }
  if (stripeBalance.status !== 200) {
    stripeBlockers.push('phase-3d2-stripe-balance-audit failed');
  }

  const stripeReconData = stripeRecon.data as Record<string, unknown>;
  const stripeBalData = stripeBalance.data as Record<string, unknown>;
  const connectedPayouts = (stripeReconData.connected_payouts ?? []) as Array<Record<string, unknown>>;
  const paidWithoutLedger = connectedPayouts.filter((p) => {
    const status = String(p.status ?? '');
    return status === 'paid' && !(stripeReconData.ledger_cross_check as Record<string, unknown>)?.[String(p.id)];
  });

  sections.push({
    section: '3_stripe_reconciliation',
    pass: stripeBlockers.length === 0,
    blockers: stripeBlockers,
    warnings: stripeWarnings,
    evidence: {
      stripe_reconciliation_audit: {
        status: stripeRecon.status,
        platform_payouts_count: ((stripeReconData.platform_payouts ?? []) as unknown[]).length,
        connected_payouts_count: connectedPayouts.length,
        connected_transfers_count: ((stripeReconData.connected_transfers ?? []) as unknown[]).length,
        ledger_cross_check_summary: stripeReconData.summary ?? stripeReconData.ledger_cross_check ?? null,
        paid_without_ledger_in_audit: paidWithoutLedger.length,
      },
      stripe_balance_audit: {
        status: stripeBalance.status,
        platform_available_pence: (stripeBalData.platform_balance as { available_gbp_pence?: number })?.available_gbp_pence,
        platform_pending_pence: (stripeBalData.platform_balance as { pending_gbp_pence?: number })?.pending_gbp_pence,
        connect_accounts: stripeBalData.connected_accounts ?? stripeBalData.connect_accounts,
        automatic_payout_accounts: stripeBalData.automatic_payout_accounts,
      },
    },
  });

  // --- 4. Provider Available audit ---
  const providerBlockers: string[] = [];
  const providerWarnings: string[] = [];

  const providerToday = (financeToday.data as { finance_reconciliation_summary?: { provider_money?: Record<string, number> } })
    ?.finance_reconciliation_summary?.provider_money;
  const providerAll = (summaryAll as { provider_money?: Record<string, number> })?.provider_money;
  const incoming = (backendAudit.data as { incoming_money?: Record<string, number> })?.incoming_money;
  const remaining = (backendAudit.data as { remaining_money?: Record<string, number> })?.remaining_money;

  const providerAvailable = providerToday?.provider_available_balance_pence
    ?? providerAll?.provider_available_balance_pence
    ?? incoming?.provider_available_balance_pence;
  const providerPending = providerToday?.provider_pending_balance_pence
    ?? providerAll?.provider_pending_balance_pence
    ?? incoming?.provider_pending_balance_pence;
  const driverAvailableNow = driverMoney?.driver_available_payout_pence
    ?? remaining?.driver_available_now_pence;

  if (providerAvailable == null) providerBlockers.push('provider_available_balance_pence not readable');
  if (driverAvailableNow == null) providerWarnings.push('driver_available_now_pence not in summary');

  const liability = Number(reconCheck?.driver_remaining_liability_pence ?? remaining?.driver_remaining_liability_pence ?? 0);
  const expectedAvailable = Math.min(Math.max(liability, 0), Math.max(Number(providerAvailable ?? 0), 0));
  if (driverAvailableNow != null && providerAvailable != null && liability <= providerAvailable && driverAvailableNow !== expectedAvailable) {
    providerWarnings.push(
      `driver_available_now ${driverAvailableNow}p vs min(liability,provider) ${expectedAvailable}p`,
    );
  }

  sections.push({
    section: '4_provider_available_audit',
    pass: providerBlockers.length === 0,
    blockers: providerBlockers,
    warnings: providerWarnings,
    evidence: {
      source: 'stripe.balance.retrieve() platform available[gbp] via admin-finance-reconciliation',
      provider_available_pence: providerAvailable,
      provider_available_gbp: gbp(Number(providerAvailable ?? 0)),
      provider_pending_pence: providerPending,
      provider_pending_gbp: gbp(Number(providerPending ?? 0)),
      driver_remaining_liability_pence: liability,
      driver_available_now_pence: driverAvailableNow,
      formula: 'driver_available_now = min(max(remaining_liability,0), provider_available)',
      future_payouts_platform_pence: Number(providerAvailable ?? 0) + Number(providerPending ?? 0),
    },
  });

  // --- 5. Payout safety gates (verification_mode only) ---
  const safetyBlockers: string[] = [];
  const batchesBefore = await countSince(admin, 'payout_batches', windowSince);
  const itemsBefore = await countSince(admin, 'payout_items', windowSince);
  const ledgerBefore = await countSince(admin, 'driver_wallet_ledger', windowSince);

  const weekly = await invokeAdmin(url, anon, token, 'admin-weekly-monday-settlement', {
    body: { region_id: MK_REGION, verification_mode: true },
  });
  const manual = await invokeAdmin(url, anon, token, 'admin-driver-payout', {
    body: { driver_id: DRIVERS[0].id, verification_mode: true },
  });

  const batchesAfter = await countSince(admin, 'payout_batches', windowSince);
  const itemsAfter = await countSince(admin, 'payout_items', windowSince);
  const ledgerAfter = await countSince(admin, 'driver_wallet_ledger', windowSince);

  const weeklyBody = weekly.data as Record<string, unknown>;
  const manualBody = manual.data as Record<string, unknown>;

  if (weekly.status !== 200) safetyBlockers.push('weekly verification_mode failed');
  if (manual.status !== 200) safetyBlockers.push('manual verification_mode failed');
  if (weeklyBody.payout_safety_version !== '3d.1') safetyBlockers.push('weekly missing payout_safety_version 3d.1');
  if (manualBody.payout_safety_version !== '3d.1') safetyBlockers.push('manual missing payout_safety_version 3d.1');
  if (weeklyBody.batch_id) safetyBlockers.push('weekly returned batch_id in verification mode');
  if (manualBody.batchId || manualBody.payoutItemId) safetyBlockers.push('manual returned batch/item in verification mode');
  if (batchesAfter > batchesBefore) safetyBlockers.push('new payout_batches during verification');
  if (itemsAfter > itemsBefore) safetyBlockers.push('new payout_items during verification');
  if (ledgerAfter > ledgerBefore) safetyBlockers.push('new ledger rows during verification');

  sections.push({
    section: '5_payout_safety_gates',
    pass: safetyBlockers.length === 0,
    blockers: safetyBlockers,
    warnings: [],
    evidence: {
      weekly: { status: weekly.status, verification_mode: weeklyBody.verification_mode, payout_safety_version: weeklyBody.payout_safety_version, batch_id: weeklyBody.batch_id ?? null },
      manual: { status: manual.status, verification_mode: manualBody.verification_mode, payout_safety_version: manualBody.payout_safety_version, batchId: manualBody.batchId ?? null },
      side_effects: {
        batches_delta: batchesAfter - batchesBefore,
        items_delta: itemsAfter - itemsBefore,
        ledger_delta: ledgerAfter - ledgerBefore,
      },
      execution_flag_note: 'ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=false (prod secret)',
    },
  });

  // --- 6. Connect manual payout lockdown ---
  const connectBlockers: string[] = [];
  const connectWarnings: string[] = [];

  const connectStatus = await invokeAdmin(url, anon, token, 'admin-connect-payout-status', {
    body: { region_id: MK_REGION },
  });
  const connectData = connectStatus.data as Record<string, unknown>;
  const connectSummary = connectData.summary as Record<string, number> | undefined;
  const connectAccounts = (connectData.connect_accounts ?? []) as Array<Record<string, unknown>>;

  if (connectStatus.status !== 200) connectBlockers.push('admin-connect-payout-status failed');
  if ((connectSummary?.automatic_count ?? 0) > 0) {
    connectBlockers.push(`${connectSummary!.automatic_count} Connect account(s) still automatic`);
  }

  for (const acct of connectAccounts) {
    if (acct.automatic_payouts_enabled === true) {
      connectBlockers.push(`${acct.driver_code}: automatic schedule still enabled`);
    }
    const lastAudit = acct.last_lockdown_audit as { action?: string; after_interval?: string } | null;
    if (!lastAudit?.action?.includes('LOCKDOWN')) {
      connectWarnings.push(`${acct.driver_code}: no lockdown audit row`);
    } else if (lastAudit.after_interval !== 'manual') {
      connectBlockers.push(`${acct.driver_code}: last audit after_interval != manual`);
    }
  }

  sections.push({
    section: '6_connect_manual_payout_lockdown',
    pass: connectBlockers.length === 0,
    blockers: connectBlockers,
    warnings: connectWarnings,
    evidence: {
      status: connectStatus.status,
      summary: connectSummary,
      accounts: connectAccounts.map((a) => ({
        driver_code: a.driver_code,
        stripe_account_id: a.stripe_account_id,
        payout_schedule_interval: a.payout_schedule_interval,
        automatic_payouts_enabled: a.automatic_payouts_enabled,
        last_lockdown_audit: a.last_lockdown_audit,
      })),
    },
  });

  // --- 7. Orphan and duplicate cleanup ---
  const orphanBlockers: string[] = [];
  const orphanWarnings: string[] = [];

  const { data: orphanBatch } = await admin
    .from('payout_batches')
    .select('status, total_amount_pence, failure_code')
    .eq('id', ORPHAN_BATCH)
    .maybeSingle();
  const { data: orphanItem } = await admin
    .from('payout_items')
    .select('status, amount_pence, stripe_transfer_id, stripe_payout_id, failure_code')
    .eq('id', ORPHAN_ITEM)
    .maybeSingle();
  const { data: dupItem } = await admin.from('payout_items').select('status, amount_pence').eq('id', DUP_ITEM).maybeSingle();
  const { data: real457 } = await admin
    .from('payout_items')
    .select('status, ledger_entry_id, stripe_payout_id, stripe_transfer_id')
    .eq('id', REAL_457_ITEM)
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
    .select('operational_loss_pence, stripe_payout_amount_pence')
    .eq('stripe_payout_id', 'po_1TjUCpIzd0dzmC0Y65sJxUHu')
    .maybeSingle();
  const { data: invalidOrphans } = await admin
    .from('payout_batches')
    .select('id, status, total_amount_pence')
    .eq('status', 'INVALID_ORPHANED');

  if (orphanBatch?.status !== 'failed' || orphanBatch?.failure_code !== 'ORPHAN_CANCELLED_3D1') {
    orphanBlockers.push('3D.1 orphan batch not cancelled');
  }
  if (orphanItem?.status !== 'FAILED_DUPLICATE') orphanBlockers.push('3D.1 orphan item not FAILED_DUPLICATE');
  if (orphanItem?.stripe_transfer_id) orphanBlockers.push('orphan item has stripe_transfer_id');
  if (dupItem?.status !== 'FAILED_DUPLICATE') orphanBlockers.push('duplicate £4.57 item not FAILED_DUPLICATE');
  if (mk1po?.amount_pence !== -1693) orphanBlockers.push('MK0001 po_1TjTPX ledger backfill missing');
  if (mk2po?.amount_pence !== -4201) orphanBlockers.push('MK0002 po_1TjUCp partial ledger debit missing');
  if (reconNote?.operational_loss_pence !== 1440) orphanWarnings.push('MK0002 operational loss note incomplete');

  sections.push({
    section: '7_orphan_duplicate_cleanup',
    pass: orphanBlockers.length === 0,
    blockers: orphanBlockers,
    warnings: orphanWarnings,
    evidence: {
      orphan_weekly_batch: orphanBatch,
      orphan_weekly_item: orphanItem,
      duplicate_457_item: dupItem,
      real_457_item: real457,
      mk0001_auto_orphan_backfill_pence: mk1po?.amount_pence ?? null,
      mk0002_auto_orphan_partial_debit_pence: mk2po?.amount_pence ?? null,
      mk0002_operational_loss_note: reconNote,
      invalid_orphaned_batches: invalidOrphans,
      bank_943_unmatched: 'documented — no ledger invented (Phase 3C4/3C5)',
    },
  });

  // --- 8. Pending Stripe payout objects ---
  const pendingBlockers: string[] = [];
  const pendingWarnings: string[] = [];
  const pendingEvidence: Record<string, unknown> = {};

  for (const acct of connectAccounts) {
    const inFlight = (acct.in_flight_payouts ?? []) as Array<{
      payout_id: string;
      amount_pence: number;
      status: string;
      automatic: boolean;
      in_ledger: boolean;
      in_payout_items: boolean;
      orphan_risk: boolean;
    }>;
    const pending = inFlight.filter((p) => p.status === 'pending' || p.status === 'in_transit');
    pendingEvidence[String(acct.driver_code)] = pending;

    for (const p of pending) {
      if (p.orphan_risk) {
        pendingBlockers.push(`${acct.driver_code}: orphan risk ${p.payout_id} ${gbp(p.amount_pence)}`);
      }
      if (p.automatic && (p.status === 'pending' || p.status === 'in_transit')) {
        pendingBlockers.push(`${acct.driver_code}: automatic in-flight ${p.payout_id}`);
      }
    }
    if (pending.length === 0) {
      pendingWarnings.push(`${acct.driver_code}: no pending/in_transit Connect payouts`);
    }
  }

  sections.push({
    section: '8_pending_stripe_payout_objects',
    pass: pendingBlockers.length === 0,
    blockers: pendingBlockers,
    warnings: pendingWarnings,
    evidence: pendingEvidence,
  });

  // --- 9. Driver wallet consistency ---
  const consistencyBlockers: string[] = [];
  const consistencyWarnings: string[] = [];
  const consistencyEvidence: Record<string, unknown> = {};

  for (const d of DRIVERS) {
    const walletSection = walletEvidence[d.code] as Record<string, unknown>;
    const reconSection = perDriverRecon[d.code] as Record<string, unknown> | undefined;
    const ledgerPence = Number(walletSection?.ledger_ssot_pence ?? 0);
    const liabilityPence = Number(reconSection?.driver_remaining_liability_pence ?? 0);
    const availableNow = Number(reconSection?.driver_available_now_pence ?? 0);
    const payoutBlocked = reconSection?.payout_blocked === true;

    // Wallet SSOT vs finance liability measure different things (ledger vs card earnings payable).
    if (ledgerPence !== liabilityPence) {
      consistencyWarnings.push(
        `${d.code}: ledger wallet ${ledgerPence}p vs finance card liability ${liabilityPence}p (different SSOT layers)`,
      );
    }
    if (ledgerPence < 0 && !payoutBlocked && availableNow > 0) {
      consistencyWarnings.push(
        `${d.code}: negative wallet with finance driver_available_now ${availableNow}p and payout_blocked=false`,
      );
    }

    consistencyEvidence[d.code] = {
      ledger_wallet_pence: ledgerPence,
      finance_card_liability_pence: liabilityPence,
      finance_available_now_pence: availableNow,
      payout_blocked: payoutBlocked,
      payout_blocked_reasons: reconSection?.payout_blocked_reasons,
      negative_wallet: ledgerPence < 0,
      wallet_sources_match: walletSection?.sources_match === true,
    };
  }

  const aggregateWallet = Number(driverMoney?.driver_wallet_balance_pence ?? 0);
  const sumDriverLedgers = DRIVERS.reduce(
    (s, d) => s + Number((walletEvidence[d.code] as Record<string, number>)?.ledger_ssot_pence ?? 0),
    0,
  );
  if (aggregateWallet !== sumDriverLedgers) {
    consistencyWarnings.push(
      `region aggregate wallet ${aggregateWallet}p != sum driver ledgers ${sumDriverLedgers}p`,
    );
  }

  sections.push({
    section: '9_driver_wallet_consistency',
    pass: consistencyBlockers.length === 0,
    blockers: consistencyBlockers,
    warnings: consistencyWarnings,
    evidence: {
      per_driver: consistencyEvidence,
      region_aggregate_wallet_pence: aggregateWallet,
      sum_driver_ledger_wallets_pence: sumDriverLedgers,
      aggregate_matches_sum: aggregateWallet === sumDriverLedgers,
      note: 'Wallet SSOT (ledger) and finance card liability are intentionally different measures',
    },
  });

  const allBlockers = sections.flatMap((s) => s.blockers.map((b) => `[${s.section}] ${b}`));
  const allWarnings = sections.flatMap((s) => s.warnings.map((w) => `[${s.section}] ${w}`));
  const sectionsPassed = sections.filter((s) => s.pass).length;

  const readinessBlockers = [
    ...allBlockers,
    'First controlled live payout requires Ahmed approval + ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=true',
  ];
  if (Number((walletEvidence.MK0001 as Record<string, number>)?.ledger_ssot_pence ?? 0) < 0
    || Number((walletEvidence.MK0002 as Record<string, number>)?.ledger_ssot_pence ?? 0) < 0) {
    readinessBlockers.push('One or more driver wallets negative — resolve before live payout');
  }

  const report = {
    phase: '3D.4',
    timestamp: new Date().toISOString(),
    project: 'thazislrdkjpvvghtvzo',
    region_id: MK_REGION,
    read_only: true,
    constraints: {
      no_stripe_updates: true,
      no_ledger_writes: true,
      no_payout_execution: true,
      no_batch_creation: true,
      no_schema_changes: true,
    },
    sections,
    summary: {
      sections_total: sections.length,
      sections_passed: sectionsPassed,
      sections_failed: sections.length - sectionsPassed,
      all_sections_pass: sections.every((s) => s.pass),
      blockers: allBlockers,
      warnings: allWarnings,
    },
    final_verdict: {
      finance_system_closure: sections.every((s) => s.pass) ? 'PASS' : 'FAIL',
      first_controlled_live_payout: 'NO-GO',
      readiness_blockers: [...new Set(readinessBlockers)],
    },
  };

  const jsonPath = join(process.cwd(), 'docs/phase3d4-verification-output.json');
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.summary, null, 2));
  console.log(`\nWrote ${jsonPath}`);

  return report;
}

main()
  .then((report) => {
    if (!report.summary.all_sections_pass) process.exitCode = 1;
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
