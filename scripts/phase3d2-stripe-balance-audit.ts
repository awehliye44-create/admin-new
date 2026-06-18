#!/usr/bin/env node
/**
 * Phase 3D.2 — Invoke read-only Stripe balance audit edge function + finance reconciliation.
 */
import { createClient } from '@supabase/supabase-js';
import { writeFileSync } from 'fs';
import { join } from 'path';

const MK_REGION = '7f611e59-a9e5-42c2-b65a-61376910bb5d';

async function main() {
  const url = process.env.SUPABASE_URL!;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
  const anon = process.env.SUPABASE_ANON_KEY!;

  const stripeAuditRes = await fetch(`${url}/functions/v1/phase-3d2-stripe-balance-audit`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      apikey: anon,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  const stripeAudit = await stripeAuditRes.json();

  const admin = createClient(url, serviceKey);
  const { data: link } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: 'admin@onecab.net',
  });
  const client = createClient(url, anon);
  const { data: session } = await client.auth.verifyOtp({
    type: 'magiclink',
    token_hash: link!.properties!.hashed_token,
  });
  const token = session.session!.access_token;

  const today = new Date().toISOString().slice(0, 10);
  const finRes = await fetch(
    `${url}/functions/v1/admin-finance-reconciliation?region_id=${MK_REGION}&from=${today}T00:00:00.000Z&to=${today}T23:59:59.999Z`,
    { headers: { Authorization: `Bearer ${token}`, apikey: anon } },
  );
  const finance = await finRes.json();
  const provider = finance.finance_reconciliation_summary?.provider_money;

  const report = {
    phase: '3D.2-stripe-balance',
    timestamp: new Date().toISOString(),
    admin_finance_reconciliation: {
      provider_available_pence: provider?.provider_available_balance_pence,
      provider_pending_pence: provider?.provider_pending_balance_pence,
    },
    stripe_live_audit: stripeAudit,
  };

  const outPath = join(process.cwd(), 'docs/phase3d2-stripe-balance-audit-output.json');
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
