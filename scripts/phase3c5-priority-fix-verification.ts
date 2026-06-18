#!/usr/bin/env node
/**
 * Phase 3C.5 Priority Fix verification (post-migration).
 */
import { createClient } from '@supabase/supabase-js';

const MK_REGION = '7f611e59-a9e5-42c2-b65a-61376910bb5d';
const MK0001 = '5ed232c3-8bb5-4085-95d6-73e48e6c5e28';
const MK0002 = 'cd8bae4c-3827-4b90-98c6-10be70eb0e52';
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
  query: string,
): Promise<unknown> {
  const res = await fetch(`${url}/functions/v1/${name}?${query}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: anon,
      'Content-Type': 'application/json',
    },
  });
  return res.json();
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

  console.log('# Phase 3C.5 Priority Fix Verification\n');

  for (const [code, id] of [
    ['MK0001', MK0001],
    ['MK0002', MK0002],
  ] as const) {
    const { data: dfs } = await admin
      .from('driver_financial_summary')
      .select('wallet_balance')
      .eq('driver_id', id)
      .maybeSingle();
    const { data: ledger } = await admin
      .from('driver_wallet_ledger')
      .select('type, amount_pence')
      .eq('driver_id', id);
    const ledgerWallet = sumLedger(ledger ?? []);
    const adminWallet = Number(dfs?.wallet_balance ?? 0);
    if (adminWallet !== ledgerWallet) {
      blockers.push(`${code}: admin ${adminWallet}p != ledger ${ledgerWallet}p`);
    }
    console.log(
      `${code} wallet: admin=${gbp(adminWallet)} ledger=${gbp(ledgerWallet)} match=${adminWallet === ledgerWallet}`,
    );
  }

  const { data: mk1po } = await admin
    .from('driver_wallet_ledger')
    .select('id, amount_pence')
    .eq('stripe_payout_id', 'po_1TjTPXEXTz9Ab5IcE2GFPiaq')
    .maybeSingle();
  if (!mk1po || mk1po.amount_pence !== -1693) {
    blockers.push('MK0001 po_1TjTPX backfill missing or wrong amount');
  } else {
    console.log(`MK0001 po_1TjTPX backfill: ${mk1po.amount_pence}p OK`);
  }

  const { data: mk1wallet } = await admin
    .from('driver_financial_summary')
    .select('wallet_balance')
    .eq('driver_id', MK0001)
    .single();
  const mk1w = Number(mk1wallet?.wallet_balance ?? 0);
  if (mk1w < 80 || mk1w > 95) {
    blockers.push(`MK0001 wallet ${mk1w}p expected ~87p`);
  } else {
    console.log(`MK0001 wallet after backfill: ${gbp(mk1w)} (~£0.87) OK`);
  }

  const { data: mk2po } = await admin
    .from('driver_wallet_ledger')
    .select('id')
    .eq('stripe_payout_id', 'po_1TjUCpIzd0dzmC0Y65sJxUHu')
    .maybeSingle();
  if (mk2po) {
    blockers.push('MK0002 po_1TjUCp should NOT be backfilled yet');
  } else {
    console.log('MK0002 po_1TjUCp: not backfilled (expected) OK');
  }

  const { data: realItem } = await admin
    .from('payout_items')
    .select('status, ledger_entry_id, stripe_transfer_id')
    .eq('id', '2c50b7df-dcae-40be-9888-f89f061e0f4b')
    .single();
  if (
    realItem?.status !== 'completed' ||
    realItem?.ledger_entry_id !== '3448df70-8f1e-4bcf-9062-dfb2fcc3f8ef'
  ) {
    blockers.push('Manual payout item 2c50b7df not linked/completed');
  } else {
    console.log('Manual payout item linked + completed OK');
  }

  const { data: dupItem } = await admin
    .from('payout_items')
    .select('status, net_driver_payout_pence')
    .eq('id', 'c5bcd2f7-36f6-44ba-a36d-9822ac32ed44')
    .single();
  if (dupItem?.status !== 'FAILED_DUPLICATE') {
    blockers.push('Duplicate payout item not FAILED_DUPLICATE');
  } else {
    console.log('Duplicate payout item FAILED_DUPLICATE OK');
  }

  const monday = (await invokeAdmin(
    url,
    anon,
    token,
    'admin-monday-payout-diagnostics',
    `region_id=${MK_REGION}&today=false`,
  )) as {
    monday_payout_today_cards?: { driver_payout_pending_pence?: number };
    monday_payout_diagnostics?: Array<{ reconciliation_status: string }>;
  };
  const pending = Number(monday.monday_payout_today_cards?.driver_payout_pending_pence ?? -1);
  console.log(`Monday pending (all recent): ${gbp(pending)}`);
  const mismatches = (monday.monday_payout_diagnostics ?? []).filter(
    (r) => r.reconciliation_status === 'RECONCILIATION_MISMATCH',
  ).length;
  console.log(`Monday diagnostics mismatches: ${mismatches}`);

  const finance = (await invokeAdmin(
    url,
    anon,
    token,
    'admin-finance-reconciliation',
    `region_id=${MK_REGION}`,
  )) as { finance_reconciliation_summary?: { reconciliation_status?: string } };
  console.log(
    `Finance reconciliation: ${finance.finance_reconciliation_summary?.reconciliation_status ?? 'unknown'}`,
  );

  if (blockers.length) {
    console.error('\n## BLOCKERS\n');
    blockers.forEach((b) => console.error(`- ${b}`));
    process.exit(1);
  }
  console.log('\n## PASS\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
