#!/usr/bin/env node
/**
 * Phase 3C.4 — Admin wallet SSOT alignment verification (read-only).
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
  query: string,
): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`${url}/functions/v1/${name}?${query}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: anon,
      'Content-Type': 'application/json',
    },
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

  console.log('# Phase 3C.4 Admin Wallet SSOT Verification\n');

  const blockers: string[] = [];
  const drivers: Record<string, unknown> = {};

  for (const d of DRIVERS) {
    const { data: dfs } = await admin
      .from('driver_financial_summary')
      .select('wallet_balance, amount_owed_to_onecab, net_available_for_payout')
      .eq('driver_id', d.id)
      .maybeSingle();

    const { data: ledger } = await admin
      .from('driver_wallet_ledger')
      .select('type, amount_pence')
      .eq('driver_id', d.id);

    const ledgerWallet = sumLedger(ledger ?? [], WALLET_EXCL);
    const adminWallet = Number(dfs?.wallet_balance ?? 0);
    const owed = Number(dfs?.amount_owed_to_onecab ?? 0);

    const finance = await invokeAdmin(
      url,
      anon,
      token,
      'admin-finance-reconciliation',
      `driver_id=${d.id}&region_id=${MK_REGION}`,
    );
    const ssot = (finance.data as { finance_reconciliation_driver_ssot?: Record<string, number> })
      ?.finance_reconciliation_driver_ssot;
    const liability = Number(ssot?.driver_remaining_liability_pence ?? NaN);

    const adminMatchesLedger = adminWallet === ledgerWallet;
    const liabilityMatchesLedger = Number.isFinite(liability)
      ? Math.max(0, ledgerWallet) === liability
      : null;

    if (!adminMatchesLedger) {
      blockers.push(`${d.code}: admin ${adminWallet}p != ledger ${ledgerWallet}p`);
    }
    if (liabilityMatchesLedger === false) {
      blockers.push(
        `${d.code}: finance liability ${liability}p != max(0, ledger ${ledgerWallet})p`,
      );
    }
    if (owed > 0 && adminWallet > 0 && owed > adminWallet) {
      // informational — debt classification uses amount_owed_to_onecab, not wallet sign
    }

    drivers[d.code] = {
      admin_wallet_pence: adminWallet,
      admin_wallet: gbp(adminWallet),
      ledger_wallet_pence: ledgerWallet,
      ledger_wallet: gbp(ledgerWallet),
      finance_liability_pence: Number.isFinite(liability) ? liability : null,
      finance_liability: Number.isFinite(liability) ? gbp(liability) : null,
      amount_owed_to_onecab_pence: owed,
      admin_matches_ledger: adminMatchesLedger,
      liability_matches_ledger: liabilityMatchesLedger,
    };
  }

  const { data: regionRows } = await admin
    .from('driver_financial_summary')
    .select('wallet_balance, amount_owed_to_onecab')
    .eq('region_id', MK_REGION);

  const adminRegionWallet = (regionRows ?? []).reduce(
    (s, r) => s + Number(r.wallet_balance ?? 0),
    0,
  );

  const financeRegion = await invokeAdmin(
    url,
    anon,
    token,
    'admin-finance-reconciliation',
    `region_id=${MK_REGION}`,
  );
  const summary = (financeRegion.data as {
    finance_reconciliation_summary?: {
      driver_money?: { driver_remaining_liability_pence?: number };
    };
  })?.finance_reconciliation_summary?.driver_money;
  const financeRegionLiability = Number(summary?.driver_remaining_liability_pence ?? NaN);

  const regionMatch =
    Number.isFinite(financeRegionLiability) && adminRegionWallet === financeRegionLiability;
  if (!regionMatch && Number.isFinite(financeRegionLiability)) {
    blockers.push(
      `MK region: admin wallet rollup ${adminRegionWallet}p != finance liability ${financeRegionLiability}p`,
    );
  }

  const report = {
    phase: '3C.4',
    drivers,
    region: {
      admin_wallet_rollup_pence: adminRegionWallet,
      admin_wallet_rollup: gbp(adminRegionWallet),
      finance_liability_pence: Number.isFinite(financeRegionLiability)
        ? financeRegionLiability
        : null,
      finance_liability: Number.isFinite(financeRegionLiability)
        ? gbp(financeRegionLiability)
        : null,
      match: regionMatch,
    },
    blockers,
    go_payout_enablement: blockers.length === 0 ? 'NO-GO until Ahmed approval' : 'NO-GO',
  };

  console.log(JSON.stringify(report, null, 2));

  if (blockers.length > 0) {
    console.error('\n## BLOCKERS\n');
    blockers.forEach((b) => console.error(`- ${b}`));
    process.exitCode = 1;
  } else {
    console.log('\n## PASS — wallet SSOT aligned (payout enablement still requires Ahmed approval)\n');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
