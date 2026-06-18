#!/usr/bin/env node
/**
 * Phase 3D.3 — Connect auto-payout lockdown verification (read-only + dry-run only).
 * Does NOT apply lockdown unless PHASE_3D3_APPLY_LOCKDOWN=true (explicit opt-in).
 */
import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'fs';
import { join } from 'path';

const MK_REGION = '7f611e59-a9e5-42c2-b65a-61376910bb5d';

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

async function countLedgerSince(admin: ReturnType<typeof createClient>, since: string) {
  const { count } = await admin
    .from('driver_wallet_ledger')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', since);
  return count ?? 0;
}

async function main() {
  const url = process.env.SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const anon = process.env.SUPABASE_ANON_KEY!;
  const admin = createClient(url, serviceKey);
  const applyLockdown = process.env.PHASE_3D3_APPLY_LOCKDOWN === 'true';

  const token = await getAdminToken(admin, url, anon);
  const windowSince = new Date().toISOString();
  const ledgerBefore = await countLedgerSince(admin, windowSince);

  const statusBefore = await invokeAdmin(url, anon, token, 'admin-connect-payout-status', {
    region_id: MK_REGION,
  });

  const dryRun = await invokeAdmin(url, anon, token, 'admin-connect-payout-lockdown', {
    dry_run: true,
    region_id: MK_REGION,
  });

  let applyResult: { status: number; data: unknown } | null = null;
  if (applyLockdown) {
    applyResult = await invokeAdmin(url, anon, token, 'admin-connect-payout-lockdown', {
      confirm_lockdown: true,
      region_id: MK_REGION,
    });
  }

  const statusAfter = await invokeAdmin(url, anon, token, 'admin-connect-payout-status', {
    region_id: MK_REGION,
  });

  const payoutSafety = await invokeAdmin(url, anon, token, 'admin-driver-payout', {
    driver_id: '5ed232c3-8bb5-4085-95d6-73e48e6c5e28',
    verification_mode: true,
  });

  const ledgerAfter = await countLedgerSince(admin, windowSince);

  const blockers: string[] = [];
  const statusBody = statusAfter.data as Record<string, unknown>;
  const summary = statusBody.summary as Record<string, number> | undefined;
  const accounts = (statusBody.connect_accounts ?? []) as Array<Record<string, unknown>>;

  if (statusBefore.status !== 200) blockers.push('status endpoint failed (before)');
  if (dryRun.status !== 200) blockers.push('dry-run lockdown failed');
  if (statusAfter.status !== 200) blockers.push('status endpoint failed (after)');

  if ((summary?.automatic_count ?? 0) > 0) {
    blockers.push(`${summary!.automatic_count} Connect account(s) still on automatic schedule`);
  }

  for (const acct of accounts) {
    if (acct.automatic_payouts_enabled === true) {
      blockers.push(`automatic schedule enabled: ${acct.driver_code ?? acct.stripe_account_id}`);
    }
    const inFlight = (acct.in_flight_payouts ?? []) as Array<{
      automatic: boolean;
      payout_id: string;
      status: string;
    }>;
    for (const p of inFlight) {
      if (
        p.automatic &&
        (p.status === 'pending' || p.status === 'in_transit')
      ) {
        blockers.push(`in-flight automatic payout: ${p.payout_id} on ${acct.driver_code}`);
      }
    }
  }

  const dryBody = dryRun.data as Record<string, unknown>;
  if (dryBody.dry_run !== true) blockers.push('dry-run response missing dry_run flag');

  if (applyLockdown && applyResult) {
    const applyBody = applyResult.data as Record<string, unknown>;
    if (applyResult.status !== 200) blockers.push('apply lockdown failed');
    if (applyBody.all_manual !== true) blockers.push('apply lockdown: not all manual after apply');
  }

  const safetyBody = payoutSafety.data as Record<string, unknown>;
  if (safetyBody.verification_mode !== true || safetyBody.payout_safety_version !== '3d.1') {
    blockers.push('admin-driver-payout 3D.1 gate not active');
  }
  if (safetyBody.batchId || safetyBody.payoutItemId) {
    blockers.push('admin-driver-payout returned batch/item in verification mode');
  }

  if (ledgerAfter > ledgerBefore) blockers.push('new driver_wallet_ledger rows during verification');

  const report: Record<string, unknown> = {
    phase: '3D.3',
    timestamp: new Date().toISOString(),
    apply_lockdown_requested: applyLockdown,
    status_before: statusBefore,
    dry_run: dryRun,
    apply_result: applyResult,
    status_after: statusAfter,
    payout_safety_check: payoutSafety,
    ledger_delta: ledgerAfter - ledgerBefore,
    blockers,
    pass: blockers.length === 0,
  };

  const outPath = join(process.cwd(), 'docs/phase3d3-verification-output.json');
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  if (blockers.length > 0) {
    console.error('\nFAIL:', blockers.join('; '));
    if (!applyLockdown && (summary?.automatic_count ?? 0) > 0) {
      console.error('Hint: set PHASE_3D3_APPLY_LOCKDOWN=true to apply manual schedule after dry-run review');
    }
    process.exit(1);
  }
  console.log('\nPASS — all Connect accounts manual, no ledger writes, payout path gated');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
