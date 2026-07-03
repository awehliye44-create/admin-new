#!/usr/bin/env npx tsx
/** Proof — FR Connect Accounts per-row last_synced_at */
import { createClient } from '@supabase/supabase-js';
import { execSync } from 'node:child_process';

const PROJECT_REF = 'thazislrdkjpvvghtvzo';
const MK_REGION = '7f611e59-a9e5-42c2-b65a-61376910bb5d';

function serviceRoleKey(): string {
  const raw = execSync(`supabase projects api-keys --project-ref ${PROJECT_REF} -o json`, { encoding: 'utf8' });
  return JSON.parse(raw).find((k: { name: string }) => k.name === 'service_role').api_key;
}

async function main() {
  const url = `https://${PROJECT_REF}.supabase.co`;
  const keys = JSON.parse(execSync(`supabase projects api-keys --project-ref ${PROJECT_REF} -o json`, { encoding: 'utf8' }));
  const anon = keys.find((k: { name: string }) => k.name === 'anon').api_key;
  const admin = createClient(url, serviceRoleKey());

  const { data: link } = await admin.auth.admin.generateLink({ type: 'magiclink', email: 'admin@onecab.net' });
  const client = createClient(url, anon);
  const { data: session } = await client.auth.verifyOtp({
    type: 'magiclink',
    token_hash: link!.properties!.hashed_token,
  });

  const res = await fetch(`${url}/functions/v1/admin-finance-reconciliation?region_id=${MK_REGION}`, {
    headers: { Authorization: `Bearer ${session!.session!.access_token}`, apikey: anon },
  });
  const data = await res.json();
  const mm = data.finance_reconciliation_summary?.money_movement;

  const rows = (mm?.connect_accounts ?? []).map((a: {
    driver_code: string | null;
    driver_name: string;
    stripe_live_balance_pence: number;
    last_synced_at: string;
  }) => ({
    driver_code: a.driver_code,
    driver_name: a.driver_name,
    stripe_live_balance_pence: a.stripe_live_balance_pence,
    last_synced_at: a.last_synced_at,
  }));

  console.log(JSON.stringify({
    stripe_balance_error: data.meta?.stripe_balance_error ?? null,
    money_movement_last_synced_at: mm?.last_synced_at ?? null,
    connect_account_count: rows.length,
    connect_accounts: rows,
  }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
