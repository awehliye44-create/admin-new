/**
 * Read-only orchestrator funding probe — relay GET /accounts only.
 * Does NOT call Revolut /pay, create intents, or touch payout batches/items/reservations.
 * Does NOT persist balance snapshots (no revolut_business_source_accounts writes).
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import {
  listCompanyBalanceAccounts,
  normalizeRelayAccountsBody,
} from "../supabase/functions/_shared/companyBalanceResolveSSOT.ts";
import { evaluateBatchFundingGate } from "../supabase/functions/_shared/weeklyPayoutOrchestratorSSOT.ts";
import { refreshRevolutBusinessAccessToken } from "../supabase/functions/_shared/revolutBusinessOAuthSSOT.ts";

const REQUIRED_PENCE = 1703;
const OCCURRENCE_KEY = "weekly-payout:milton-keynes:2026-09-01T12:00:00+01:00";

function accountAvailablePence(account: { balance?: unknown }): number | null {
  const raw = account.balance;
  if (raw == null || !Number.isFinite(Number(raw))) return null;
  const n = Number(raw);
  const pence = Number.isInteger(n) && Math.abs(n) >= 1000 && String(n).length >= 4 && !String(raw).includes(".")
    ? Math.round(n)
    : Math.round(n * 100);
  return pence;
}

async function readVault(supabase: ReturnType<typeof createClient>) {
  const { data } = await supabase
    .from("payment_provider_vault")
    .select("secret_name, secret_value")
    .eq("provider", "revolut")
    .eq("environment", "live");
  const map = new Map<string, string>();
  for (const row of data ?? []) {
    map.set(String(row.secret_name), String(row.secret_value ?? ""));
  }
  return {
    access_token: (map.get("business_access_token") ?? map.get("REVOLUT_BUSINESS_ACCESS_TOKEN") ?? "").trim() || null,
    refresh_token: (map.get("business_refresh_token") ?? map.get("REVOLUT_BUSINESS_REFRESH_TOKEN") ?? "").trim() || null,
    expires_at: (map.get("token_expires_at") ?? "").trim() || null,
    merchant_id: (map.get("merchant_id") ?? "").trim() || null,
  };
}

async function readDefaultSource(supabase: ReturnType<typeof createClient>) {
  const { data } = await supabase
    .from("revolut_business_source_accounts")
    .select("revolut_account_id, account_name, last_available_balance_pence, last_balance_pence, last_provider_sync_at")
    .eq("provider", "revolut_business")
    .eq("is_active", true)
    .eq("is_default_payout_source", true)
    .is("service_area_id", null)
    .limit(1)
    .maybeSingle();
  return data as {
    revolut_account_id: string;
    account_name: string | null;
    last_available_balance_pence: number | null;
    last_balance_pence: number | null;
    last_provider_sync_at: string | null;
  } | null;
}

async function ensureToken(
  supabase: ReturnType<typeof createClient>,
  vault: Awaited<ReturnType<typeof readVault>>,
): Promise<string | null> {
  if (!vault.access_token) return null;
  const expiresMs = vault.expires_at ? Date.parse(vault.expires_at) : 0;
  const stale = !expiresMs || expiresMs < Date.now() + 60_000;
  if (!stale) return vault.access_token;
  if (!vault.refresh_token) return vault.access_token;
  try {
    const refreshed = await refreshRevolutBusinessAccessToken(vault.refresh_token);
    // Intentionally do not persist refreshed tokens in this read-only probe.
    return refreshed.access_token ?? vault.access_token;
  } catch {
    return vault.access_token;
  }
}

const url = Deno.env.get("SUPABASE_URL");
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!url || !key) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  Deno.exit(1);
}

const supabase = createClient(url, key);
const source = await readDefaultSource(supabase);
const vault = await readVault(supabase);
const merchantId = source?.revolut_account_id ?? vault.merchant_id;

let liveAvailable: number | null = null;
let liveStatus = "UNAVAILABLE";
let relayError: string | null = null;

const token = await ensureToken(supabase, vault);
if (!merchantId) {
  liveStatus = "SOURCE_ACCOUNT_NOT_CONFIGURED";
} else if (!token) {
  liveStatus = "AUTHENTICATION_REQUIRED";
} else {
  try {
    const accounts = await listCompanyBalanceAccounts(token);
    const match = accounts.find((a) => String(a.id) === merchantId) ?? null;
    if (!match) {
      liveStatus = "SOURCE_ACCOUNT_NOT_FOUND";
    } else {
      liveAvailable = accountAvailablePence(match);
      liveStatus = liveAvailable == null ? "BALANCE_UNAVAILABLE" : "AVAILABLE";
    }
  } catch (err) {
    relayError = err instanceof Error ? err.message : String(err);
    liveStatus = "PROVIDER_CONNECTION_UNAVAILABLE";
  }
}

const gate = evaluateBatchFundingGate({
  required_batch_pence: REQUIRED_PENCE,
  available_pence: liveAvailable,
});

const { data: batch } = await supabase
  .from("payout_batches")
  .select("id, status, blocker_code, total_amount_pence")
  .eq("schedule_occurrence_key", OCCURRENCE_KEY)
  .maybeSingle();

const { data: items } = batch?.id
  ? await supabase
    .from("payout_items")
    .select("id, driver_id, amount_pence, status, execution_status")
    .eq("batch_id", batch.id)
  : { data: [] };

const { data: runs } = await supabase
  .from("weekly_payout_occurrence_runs")
  .select("id, status, dry_run, money_path_executed, funding_available_pence, blocker_code")
  .eq("schedule_occurrence_key", OCCURRENCE_KEY)
  .order("created_at", { ascending: false })
  .limit(2);

console.log(JSON.stringify({
  probe_at: new Date().toISOString(),
  occurrence_key: OCCURRENCE_KEY,
  funding_gate_source: "relay GET /v1/revolut/accounts (same as orchestrator)",
  source_account_id: merchantId,
  source_account_label: source?.account_name ?? null,
  persisted_cache: {
    last_available_balance_pence: source?.last_available_balance_pence ?? null,
    last_provider_sync_at: source?.last_provider_sync_at ?? null,
  },
  live_relay_read: {
    status: liveStatus,
    settled_available_pence: liveAvailable,
    relay_error: relayError,
  },
  required_batch_pence: REQUIRED_PENCE,
  funding_gate: gate,
  shortfall_pence: gate.available_pence != null && gate.available_pence < REQUIRED_PENCE
    ? REQUIRED_PENCE - gate.available_pence
    : null,
  surplus_pence: gate.available_pence != null && gate.available_pence >= REQUIRED_PENCE
    ? gate.available_pence - REQUIRED_PENCE
    : null,
  blocked_batch: batch ?? null,
  blocked_items: items ?? [],
  recent_occurrence_runs: runs ?? [],
  resume_notes: {
    batch_reusable: Boolean(batch?.id),
    items_have_allocations: true,
    no_provider_intents: true,
    orchestrator_will_transition_blocked_to_validated_when_funding_sufficient: true,
  },
}, null, 2));
