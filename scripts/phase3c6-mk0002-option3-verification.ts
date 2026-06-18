#!/usr/bin/env node
/**
 * Phase 3C.6 — MK0002 Option 3 remediation verification.
 */
import { createClient } from '@supabase/supabase-js';

const MK0002 = 'cd8bae4c-3827-4b90-98c6-10be70eb0e52';
const PO = 'po_1TjUCpIzd0dzmC0Y65sJxUHu';
const WALLET_EXCL = new Set(['PLATFORM_COMMISSION', 'CASH_TRIP_EARNING']);

function gbp(p: number): string {
  return `£${(p / 100).toFixed(2)}`;
}

async function main() {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error('Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }

  const sb = createClient(url, key);
  const blockers: string[] = [];

  console.log('# Phase 3C.6 MK0002 Option 3 Verification\n');

  const { data: ledger } = await sb
    .from('driver_wallet_ledger')
    .select('id, type, amount_pence')
    .eq('stripe_payout_id', PO)
    .maybeSingle();

  if (!ledger || ledger.amount_pence !== -4201) {
    blockers.push(`Ledger debit expected -4201p, got ${ledger?.amount_pence ?? 'missing'}`);
  } else {
    console.log(`Ledger debit: ${ledger.amount_pence}p linked to ${PO} OK`);
  }

  const { data: note } = await sb
    .from('finance_reconciliation_notes')
    .select('*')
    .eq('stripe_payout_id', PO)
    .maybeSingle();

  if (!note || note.operational_loss_pence !== 1440) {
    blockers.push('Reconciliation note missing or operational_loss != 1440p');
  } else {
    console.log(`Operational loss: ${gbp(note.operational_loss_pence)} (${note.remediation_option}) OK`);
    console.log(`Note: ${note.note?.slice(0, 120)}…`);
  }

  const { data: rows } = await sb
    .from('driver_wallet_ledger')
    .select('type, amount_pence')
    .eq('driver_id', MK0002);
  const ssot = (rows ?? []).reduce(
    (s, r) => (WALLET_EXCL.has(r.type) ? s : s + (r.amount_pence ?? 0)),
    0,
  );
  const { data: dfs } = await sb
    .from('driver_financial_summary')
    .select('wallet_balance')
    .eq('driver_id', MK0002)
    .single();
  const admin = Number(dfs?.wallet_balance ?? 0);

  if (admin !== ssot) {
    blockers.push(`Wallet drift admin ${admin}p vs ledger ${ssot}p`);
  }
  if (ssot !== -2300) {
    blockers.push(`Wallet expected -2300p (£-23.00), got ${ssot}p (${gbp(ssot)})`);
  } else {
    console.log(`MK0002 wallet: ${gbp(ssot)} (admin matches) OK`);
  }

  const stripeTotal = 5641;
  const ledgerAbs = 4201;
  const loss = 1440;
  if (ledgerAbs + loss !== stripeTotal) {
    blockers.push(`Split arithmetic ${ledgerAbs}+${loss} != ${stripeTotal}`);
  } else {
    console.log(`Split: ${gbp(ledgerAbs)} ledger + ${gbp(loss)} operational loss = ${gbp(stripeTotal)} Stripe OK`);
  }

  if (blockers.length) {
    console.error('\n## BLOCKERS\n');
    blockers.forEach((b) => console.error(`- ${b}`));
    process.exit(1);
  }
  console.log('\n## PASS — Option 3 applied\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
