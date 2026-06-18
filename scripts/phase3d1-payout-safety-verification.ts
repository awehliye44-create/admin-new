#!/usr/bin/env node
/**
 * Phase 3D.1 — Payout safety lockdown verification (dry-run only).
 * Expects 0 new batches, items, ledger rows, and Stripe objects after invocation.
 */
import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'fs';
import { join } from 'path';

const MK_REGION = '7f611e59-a9e5-42c2-b65a-61376910bb5d';
const MK0001 = '5ed232c3-8bb5-4085-95d6-73e48e6c5e28';
const ORPHAN_BATCH = '8819ebee-cb96-406f-9f30-035baac119c5';
const ORPHAN_ITEM = '0c12e3dc-a8e9-4331-8080-2a5c713d4e9a';

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
  body: unknown,
): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`${url}/functions/v1/${name}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: anon,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
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

async function countSnapshot(admin: ReturnType<typeof createClient>) {
  const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const [batches, items, ledger] = await Promise.all([
    admin.from('payout_batches').select('id', { count: 'exact', head: true }).gte('created_at', since),
    admin.from('payout_items').select('id', { count: 'exact', head: true }).gte('created_at', since),
    admin.from('driver_wallet_ledger').select('id', { count: 'exact', head: true }).gte('created_at', since),
  ]);
  return {
    batches_since_window: batches.count ?? 0,
    items_since_window: items.count ?? 0,
    ledger_since_window: ledger.count ?? 0,
    window_since: since,
  };
}

async function main() {
  const url = process.env.SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const anon = process.env.SUPABASE_ANON_KEY!;
  const admin = createClient(url, serviceKey);

  const token = await getAdminToken(admin, url, anon);
  const before = await countSnapshot(admin);

  const weekly = await invokeAdmin(url, anon, token, 'admin-weekly-monday-settlement', {
    region_id: MK_REGION,
    verification_mode: true,
  });

  const manual = await invokeAdmin(url, anon, token, 'admin-driver-payout', {
    driver_id: MK0001,
    verification_mode: true,
  });

  const monday = await fetch(
    `${url}/functions/v1/admin-monday-payout-diagnostics?region_id=${MK_REGION}&today=false`,
    {
      headers: { Authorization: `Bearer ${token}`, apikey: anon },
    },
  );
  const mondayData = await monday.json();

  const after = await countSnapshot(admin);

  const { data: orphanBatch } = await admin
    .from('payout_batches')
    .select('status, total_amount_pence, failure_code')
    .eq('id', ORPHAN_BATCH)
    .maybeSingle();
  const { data: orphanItem } = await admin
    .from('payout_items')
    .select('status, amount_pence, stripe_transfer_id, failure_code')
    .eq('id', ORPHAN_ITEM)
    .maybeSingle();

  const blockers: string[] = [];
  const report: Record<string, unknown> = {
    phase: '3D.1',
    timestamp: new Date().toISOString(),
    counts_before: before,
    counts_after: after,
    delta: {
      batches: (after.batches_since_window ?? 0) - (before.batches_since_window ?? 0),
      items: (after.items_since_window ?? 0) - (before.items_since_window ?? 0),
      ledger: (after.ledger_since_window ?? 0) - (before.ledger_since_window ?? 0),
    },
    weekly_verification: { status: weekly.status, body: weekly.data },
    manual_verification: { status: manual.status, body: manual.data },
    monday_diagnostics: { status: monday.status, ready_count: (mondayData as { ready_count?: number })?.ready_count },
    orphan_cancel: { batch: orphanBatch, item: orphanItem },
  };

  const weeklyBody = weekly.data as Record<string, unknown>;
  const manualBody = manual.data as Record<string, unknown>;

  if (!weeklyBody.verification_mode || weeklyBody.payout_safety_version !== '3d.1') {
    blockers.push('weekly: 3d.1 verification gate not active');
  }
  if (weeklyBody.batch_id) blockers.push('weekly: batch_id returned in verification mode');
  if (manualBody.verification_mode !== true || manualBody.payout_safety_version !== '3d.1') {
    blockers.push('manual: 3d.1 verification gate not active');
  }
  if (manualBody.batchId || manualBody.payoutItemId) {
    blockers.push('manual: batch/item ids returned in verification mode');
  }
  if ((report.delta as { batches: number }).batches > 0) blockers.push('new payout_batches created');
  if ((report.delta as { items: number }).items > 0) blockers.push('new payout_items created');
  if ((report.delta as { ledger: number }).ledger > 0) blockers.push('new ledger rows created');

  if (orphanItem?.status !== 'FAILED_DUPLICATE') {
    blockers.push('orphan item not FAILED_DUPLICATE');
  }
  if (orphanItem?.stripe_transfer_id) blockers.push('orphan item has stripe_transfer_id');
  if (orphanBatch?.status !== 'failed' || orphanBatch?.failure_code !== 'ORPHAN_CANCELLED_3D1') {
    blockers.push('orphan batch not cancelled');
  }

  report.blockers = blockers;
  report.pass = blockers.length === 0;

  const outPath = join(process.cwd(), 'docs/phase3d1-verification-output.json');
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  if (blockers.length) {
    console.error('\nBLOCKERS:', blockers);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
