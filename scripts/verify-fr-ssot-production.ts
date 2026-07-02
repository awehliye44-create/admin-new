#!/usr/bin/env node
/**
 * Post-deploy verification for admin-finance-reconciliation SSOT gaps closure.
 * Read-only — invokes live edge function and validates response shape.
 */
import { createClient } from '@supabase/supabase-js';
import { execSync } from 'node:child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

const PROJECT_REF = 'thazislrdkjpvvghtvzo';

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const file of ['.env', '.env.local']) {
    try {
      const raw = readFileSync(join(process.cwd(), file), 'utf8');
      for (const line of raw.split('\n')) {
        const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
        if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    } catch {
      // ignore
    }
  }
  return env;
}

function serviceRoleKey(): string {
  const env = loadEnv();
  if (env.SUPABASE_SERVICE_ROLE_KEY) return env.SUPABASE_SERVICE_ROLE_KEY;
  const raw = execSync(`supabase projects api-keys --project-ref ${PROJECT_REF} -o json`, { encoding: 'utf8' });
  const parsed = JSON.parse(raw);
  const entry = Array.isArray(parsed)
    ? parsed.find((k) => k.name === 'service_role')
    : parsed.keys?.find((k: { name: string }) => k.name === 'service_role');
  if (!entry?.api_key) throw new Error('Could not resolve service_role API key');
  return entry.api_key;
}

const env = loadEnv();
const url = env.VITE_SUPABASE_URL || env.SUPABASE_URL || `https://${PROJECT_REF}.supabase.co`;
const anon = env.VITE_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_PUBLISHABLE_KEY;

const MK_REGION = '7f611e59-a9e5-42c2-b65a-61376910bb5d';

async function getAdminToken(): Promise<string> {
  const admin = createClient(url, serviceRoleKey(), { auth: { persistSession: false } });
  const { data: link, error } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: 'admin@onecab.net',
  });
  if (error || !link?.properties?.hashed_token) {
    throw new Error(`admin link failed: ${error?.message}`);
  }
  const client = createClient(url, anon, { auth: { persistSession: false } });
  const { data: session, error: otpErr } = await client.auth.verifyOtp({
    type: 'magiclink',
    token_hash: link.properties.hashed_token,
  });
  if (otpErr || !session.session?.access_token) {
    throw new Error(`admin session failed: ${otpErr?.message}`);
  }
  return session.session.access_token;
}

async function invokeFr(token: string, query: string): Promise<unknown> {
  const res = await fetch(`${url}/functions/v1/admin-finance-reconciliation?${query}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: anon,
      'Content-Type': 'application/json',
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`FR ${res.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

type Check = { id: string; pass: boolean; detail: string };

async function main() {
  const checks: Check[] = [];
  const token = await getAdminToken();

  const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const to = new Date().toISOString();
  const qs = new URLSearchParams({
    region_id: MK_REGION,
    from,
    to,
  }).toString();

  const data = (await invokeFr(token, qs)) as Record<string, unknown>;

  const kpis = data.platform_kpis as Record<string, number> | null | undefined;
  const kpiKeys = [
    'balanced_drivers',
    'drivers_with_recovery',
    'outstanding_liability_pence',
    'outstanding_recovery_pence',
    'failed_payouts_pence',
    'stripe_only_records',
    'ledger_only_records',
    'todays_captures_pence',
    'todays_card_trips',
    'todays_cash_trips',
    'driver_count',
  ];
  const kpisOk = !!kpis && kpiKeys.every((k) => typeof kpis[k] === 'number');
  checks.push({
    id: '1-overview-platform_kpis',
    pass: kpisOk,
    detail: kpisOk
      ? `platform_kpis present (driver_count=${kpis!.driver_count}, balanced=${kpis!.balanced_drivers})`
      : `platform_kpis missing or incomplete: ${JSON.stringify(kpis ?? null)}`,
  });

  const audit = (data.trip_financial_audit ?? []) as Array<Record<string, unknown>>;
  const sample = audit[0];
  const auditFields = ['gross_fare_pence', 'discount_pence', 'final_fare_pence', 'onecab_gross_commission_pence', 'driver_net_pence'];
  const auditOk = audit.length === 0 || auditFields.every((f) => sample[f] !== undefined);
  checks.push({
    id: '2-trips-backend-ssot-fields',
    pass: auditOk,
    detail: audit.length === 0
      ? 'No audit rows in period (fields N/A — empty period)'
      : auditOk
        ? `Sample row has SSOT fields: gross=${sample.gross_fare_pence}, discount=${sample.discount_pence}, final=${sample.final_fare_pence}`
        : `Missing fields on sample: ${auditFields.filter((f) => sample[f] === undefined).join(', ')}`,
  });

  const mm = (data.finance_reconciliation_summary as { money_movement?: { connect_accounts?: unknown[] } })?.money_movement
    ?? data.money_movement as { connect_accounts?: unknown[] } | undefined;
  const connectCount = mm?.connect_accounts?.length ?? 0;
  checks.push({
    id: '6-stripe-connect-accounts',
    pass: connectCount > 0,
    detail: connectCount > 0 ? `${connectCount} connect_accounts in money_movement` : 'No connect_accounts returned',
  });

  const allPass = checks.every((c) => c.pass);
  console.log(JSON.stringify({ deployed: true, project: 'thazislrdkjpvvghtvzo', checks, allPass }, null, 2));
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
