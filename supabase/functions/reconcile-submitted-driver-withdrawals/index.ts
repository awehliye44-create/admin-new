/**
 * Scheduled poller: reconcile SUBMITTED EARLY_CASHOUT payout items whose
 * provider transfer has completed at Revolut but whose local record was not
 * yet finalised (financially_applied_at IS NULL).
 *
 * Concurrency safety:
 *   The claim_reconcile_payout_items RPC uses FOR UPDATE SKIP LOCKED + a
 *   double-check UPDATE … WHERE claim_token/expires to atomically assign rows
 *   to exactly one poller run. Transaction-scoped advisory locks are NOT used
 *   because they are released before the Edge function performs reconciliation.
 *
 * Safety contract:
 *   - Selects only items claimed by this invocation's unique run token.
 *   - Provider status GET only — never /pay, never new transfer.
 *   - finalize_driver_payout_completion is idempotent; the final money guard.
 *   - revolut_pay_called is always false.
 *   - dry_run: true → no claim, no meta update, no provider call, no finalize.
 *
 * Invoke: pg_cron → net.http_post every 2 minutes (single schedule only).
 * Manual: service-role POST with optional { "dry_run": true }.
 *
 * Schema prerequisite: migration 20260929150000_reconcile_poller_claim_cols.sql
 */
import { createClient } from "npm:@supabase/supabase-js@2";
import { reconcileSubmittedDriverWithdrawPayout } from "../_shared/driverWithdrawProviderReconcile.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}

// ─── Configurable constants ───────────────────────────────────────────────────
const MIN_AGE_SECONDS = Number(Deno.env.get("RECONCILE_MIN_AGE_SECONDS") ?? 120);
const MAX_PENDING_MINUTES = Number(Deno.env.get("RECONCILE_MAX_PENDING_MINUTES") ?? 120);
const BATCH_LIMIT = Math.min(50, Number(Deno.env.get("RECONCILE_BATCH_LIMIT") ?? 20));
const BACK_OFF_BASE_SECONDS = Number(Deno.env.get("RECONCILE_BACK_OFF_BASE_SECONDS") ?? 120);
const MAX_BACK_OFF_SECONDS = Number(Deno.env.get("RECONCILE_MAX_BACK_OFF_SECONDS") ?? 1800);
/** Claim TTL in seconds. Poller must finish within this window or the claim expires. */
const CLAIM_TTL_SECONDS = Number(Deno.env.get("RECONCILE_CLAIM_TTL_SECONDS") ?? 90);

// ─── Back-off ─────────────────────────────────────────────────────────────────

/**
 * Bounded exponential back-off.
 * attempt: 0-based count of prior attempts (before this one).
 */
export function computeNextRetrySeconds(attempt: number): number {
  return Math.min(
    BACK_OFF_BASE_SECONDS * Math.pow(2, attempt),
    MAX_BACK_OFF_SECONDS,
  );
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type ClaimedIntent = {
  intent_id: string;
  payout_item_id: string;
  driver_id: string;
  provider_payment_id: string;
  provider_state: string | null;
  reconcile_attempt_count: number;
  provider_created_at: string;
};

export type ReconcileOutcome =
  | "completed"
  | "pending"
  | "failed"
  | "reversed"
  | "error"
  | "already_applied";

export type ItemResult = {
  payout_item_id: string;
  intent_id: string;
  outcome: ReconcileOutcome;
  provider_state: string | null;
  revolut_pay_called: false;
  financially_applied: boolean;
  error?: string;
};

export type ReconcileFn = (args: {
  // deno-lint-ignore no-explicit-any
  supabase: any;
  payoutItemId: string;
}) => Promise<{
  ok: boolean;
  provider_state: string | null;
  provider_payment_id: string | null;
  financially_applied: boolean;
  already_applied: boolean;
  wallet_debited: boolean;
  reservation_consumed: boolean;
  item_status: string | null;
  revolut_pay_called: false;
  error?: string;
}>;

// ─── Dry-run candidate fetch ──────────────────────────────────────────────────

/**
 * In dry_run mode: read candidates without claiming them.
 * Returns the plan (what would be processed) with no side-effects.
 */
// deno-lint-ignore no-explicit-any
async function fetchDryRunCandidates(supabase: any): Promise<ClaimedIntent[]> {
  const cutoff = new Date(Date.now() - MIN_AGE_SECONDS * 1_000).toISOString();
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("driver_payout_payment_intents")
    .select(
      "id, payout_item_id, driver_id, provider_payment_id, provider_state, reconcile_attempt_count, provider_created_at",
    )
    .eq("execution_status", "SUBMITTED")
    .is("financially_applied_at", null)
    .not("provider_payment_id", "is", null)
    .lt("provider_created_at", cutoff)
    .or(`next_reconcile_at.is.null,next_reconcile_at.lte.${now}`)
    .or(`reconcile_claim_expires_at.is.null,reconcile_claim_expires_at.lte.${now}`)
    .order("provider_created_at", { ascending: true })
    .limit(BATCH_LIMIT);

  if (error || !Array.isArray(data)) return [];

  return (data as Array<Record<string, unknown>>).map((r) => ({
    intent_id: String(r.id),
    payout_item_id: String(r.payout_item_id),
    driver_id: String(r.driver_id),
    provider_payment_id: String(r.provider_payment_id ?? ""),
    provider_state: r.provider_state ? String(r.provider_state) : null,
    reconcile_attempt_count: Number(r.reconcile_attempt_count ?? 0),
    provider_created_at: String(r.provider_created_at ?? ""),
  }));
}

// ─── Durable claim ────────────────────────────────────────────────────────────

/**
 * Atomically claim eligible SUBMITTED EARLY_CASHOUT intents.
 * Uses the claim_reconcile_payout_items SECURITY DEFINER RPC which internally
 * uses FOR UPDATE SKIP LOCKED + a double-check UPDATE to guarantee each row
 * is returned to at most one concurrent poller invocation.
 */
// deno-lint-ignore no-explicit-any
async function claimCandidates(supabase: any, runToken: string): Promise<ClaimedIntent[]> {
  const { data, error } = await supabase.rpc("claim_reconcile_payout_items", {
    p_claim_token: runToken,
    p_claim_ttl_seconds: CLAIM_TTL_SECONDS,
    p_min_age_interval: `${MIN_AGE_SECONDS} seconds`,
    p_limit: BATCH_LIMIT,
  });

  if (error || !Array.isArray(data)) return [];

  return (data as Array<Record<string, unknown>>).map((r) => ({
    intent_id: String(r.intent_id),
    payout_item_id: String(r.payout_item_id),
    driver_id: String(r.driver_id),
    provider_payment_id: String(r.provider_payment_id ?? ""),
    provider_state: r.provider_state ? String(r.provider_state) : null,
    reconcile_attempt_count: Number(r.reconcile_attempt_count ?? 0),
    provider_created_at: String(r.provider_created_at ?? ""),
  }));
}

// ─── Attempt-meta persist ─────────────────────────────────────────────────────

/**
 * Persist non-financial reconcile metadata via the SECURITY DEFINER RPC.
 * Token-match guard: only the poller holding the claim can update.
 * Fails silently if the claim was stolen (should not happen in practice).
 */
// deno-lint-ignore no-explicit-any
async function persistAttemptMeta(supabase: any, args: {
  intentId: string;
  runToken: string;
  attempt: number;
  providerState: string | null;
  error: string | null;
  nextRetrySeconds: number;
  financiallyApplied: boolean;
}): Promise<void> {
  const nextAt = args.financiallyApplied
    ? null
    : new Date(Date.now() + args.nextRetrySeconds * 1_000).toISOString();

  await supabase.rpc("update_reconcile_attempt_meta", {
    p_intent_id: args.intentId,
    p_claim_token: args.runToken,
    p_attempt_count: args.attempt + 1,
    p_provider_state: args.providerState ?? null,
    p_error: args.error ?? null,
    p_next_reconcile_at: nextAt,
    p_financially_applied: args.financiallyApplied,
  });
}

// ─── Process one claimed intent ───────────────────────────────────────────────

/**
 * Reconcile one claimed intent. The claim was already acquired by the RPC;
 * no further locking is needed here.
 *
 * @param reconcileFn  Injectable for testing; defaults to the real reconcile helper.
 */
export async function processOneCandidate(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  claimed: ClaimedIntent,
  runToken: string,
  reconcileFn: ReconcileFn = reconcileSubmittedDriverWithdrawPayout,
): Promise<ItemResult> {
  const result = await reconcileFn({
    supabase,
    payoutItemId: claimed.payout_item_id,
  });

  let outcome: ReconcileOutcome = "error";
  if (result.already_applied) {
    outcome = "already_applied";
  } else if (result.financially_applied) {
    outcome = "completed";
  } else if (!result.ok) {
    const ps = String(result.provider_state ?? "").toLowerCase();
    if (ps === "failed" || ps === "declined" || ps === "rejected") {
      outcome = "failed";
    } else if (ps === "revoked" || ps === "reversed" || ps === "cancelled") {
      outcome = "reversed";
    } else {
      outcome = "error";
    }
  } else {
    // ok=true, not financially applied → provider still pending
    outcome = "pending";
  }

  const nextRetrySeconds = computeNextRetrySeconds(claimed.reconcile_attempt_count);

  await persistAttemptMeta(supabase, {
    intentId: claimed.intent_id,
    runToken,
    attempt: claimed.reconcile_attempt_count,
    providerState: result.provider_state,
    error: result.error ?? null,
    nextRetrySeconds,
    financiallyApplied: result.financially_applied,
  }).catch(() => {
    // Non-critical; log but do not fail the item result.
    console.warn(
      `[reconcile-poller] meta update failed for intent=${claimed.intent_id}`,
    );
  });

  // Operational alert for overdue items.
  if (outcome === "pending" && claimed.provider_created_at) {
    const ageMinutes =
      (Date.now() - new Date(claimed.provider_created_at).getTime()) / 60_000;
    if (ageMinutes > MAX_PENDING_MINUTES) {
      console.error(
        `[reconcile-poller] ALERT payout_item=${claimed.payout_item_id} ` +
          `pending ${Math.round(ageMinutes)}m > MAX_PENDING_MINUTES=${MAX_PENDING_MINUTES}`,
      );
    }
  }

  return {
    payout_item_id: claimed.payout_item_id,
    intent_id: claimed.intent_id,
    outcome,
    provider_state: result.provider_state,
    revolut_pay_called: false,
    financially_applied: result.financially_applied,
    ...(result.error ? { error: result.error } : {}),
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

// Guard: allow test imports without starting the HTTP server.
if (import.meta.main) {
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!supabaseUrl || !serviceKey) {
    return json({ error: "server_misconfigured" }, 500);
  }

  // Require service-role bearer.
  const authHeader = req.headers.get("Authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  let jwtRole = "";
  try {
    const payloadB64 = bearer.split(".")[1] ?? "";
    const padded = payloadB64 + "=".repeat((4 - (payloadB64.length % 4)) % 4);
    const payload = JSON.parse(
      atob(padded.replace(/-/g, "+").replace(/_/g, "/")),
    );
    jwtRole = String(payload?.role ?? "");
  } catch { jwtRole = ""; }
  const isServiceRole = jwtRole === "service_role" || bearer === serviceKey;
  if (!isServiceRole) return json({ error: "forbidden" }, 403);

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { body = {}; }
  const dryRun = body.dry_run === true;

  const supabase = createClient(supabaseUrl, serviceKey);

  if (dryRun) {
    // dry_run: report candidates only. No claim, no meta update, no provider
    // call, no finalize. Returns the plan as it would look at this moment.
    const candidates = await fetchDryRunCandidates(supabase);
    return json({
      ok: true,
      dry_run: true,
      candidate_count: candidates.length,
      candidates: candidates.map((c) => ({
        payout_item_id: c.payout_item_id,
        intent_id: c.intent_id,
        driver_id: c.driver_id,
        provider_state: c.provider_state,
        attempt: c.reconcile_attempt_count,
        age_minutes: Math.round(
          (Date.now() - new Date(c.provider_created_at).getTime()) / 60_000,
        ),
      })),
    });
  }

  // Unique run token — identifies this specific poller invocation.
  const runToken = crypto.randomUUID();

  const claimed = await claimCandidates(supabase, runToken);
  if (claimed.length === 0) {
    return json({ ok: true, processed: 0, results: [], run_token: runToken });
  }

  const results: ItemResult[] = [];
  for (const candidate of claimed) {
    const r = await processOneCandidate(supabase, candidate, runToken);
    results.push(r);
  }

  const completed = results.filter((r) => r.outcome === "completed").length;
  const pending = results.filter((r) => r.outcome === "pending").length;
  const errors = results.filter((r) => r.outcome === "error").length;
  const skipped = results.filter(
    (r) => r.outcome === "already_applied",
  ).length;

  return json({
    ok: true,
    processed: results.length,
    completed,
    pending,
    errors,
    skipped,
    run_token: runToken,
    results,
  });
});
} // end import.meta.main guard
