/**
 * Temporary Step 9.2C2 recovery — dry-run + one-time approved live credit.
 * Slug: admin-recover-five-historical-missing-ten
 *
 * Live requires confirm_execute: CREDIT_FIVE_SAVED_TRIP_EARNINGS_2629P
 * Delete after verification. Do not redeploy without new explicit approval.
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { corsHeaders as adminCors } from "../_shared/adminPaymentGate.ts";
import {
  ALLOWLIST_VIOLATION,
  CONFIRM_EXECUTE_PHRASE,
  evaluateFiveTripDryRun,
  executeFiveTripCredit,
  FIVE_HISTORICAL_MISSING_TEN_IDS,
  gateExactFiveTripAllowlist,
  isApprovedLiveExecute,
  isLiveExecutionRequest,
  LIVE_EXECUTION_DISABLED,
} from "../_shared/fiveHistoricalMissingTenDryRunSSOT.ts";

const corsHeaders = {
  ...adminCors,
  "Content-Type": "application/json",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}

async function requireSuperAdminOrServiceRole(req: Request): Promise<
  | { ok: true; userId: string }
  | { ok: false; response: Response }
> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { ok: false, response: json({ success: false, error: "Unauthorized" }, 401) };
  }
  const token = authHeader.replace("Bearer ", "");
  if (token === serviceKey) {
    return { ok: true, userId: "service-role" };
  }

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    return { ok: false, response: json({ success: false, error: "Unauthorized" }, 401) };
  }

  const { data: roleRow } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .eq("role", "admin")
    .maybeSingle();

  if (!roleRow) {
    return {
      ok: false,
      response: json({ success: false, error: "Forbidden — Super Admin required" }, 403),
    };
  }
  return { ok: true, userId: user.id };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  const gate = await requireSuperAdminOrServiceRole(req);
  if (!gate.ok) return gate.response;

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  delete body.actor;
  delete body.actor_id;
  delete body.actor_role;
  delete body.role;
  delete body.user_id;

  if (isLiveExecutionRequest(body)) {
    return json({
      error: LIVE_EXECUTION_DISABLED,
      message: `live credit requires dry_run:false and confirm_execute:\"${CONFIRM_EXECUTE_PHRASE}\"`,
    }, 400);
  }

  const allow = gateExactFiveTripAllowlist(body.trip_ids);
  if (!allow.ok) {
    return json({ error: allow.error, message: allow.message }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  // Dry-run path
  if (body.dry_run === true) {
    const evaluated = await evaluateFiveTripDryRun(admin, allow.trip_ids);
    if (!evaluated.ok) {
      return json({
        error: evaluated.error,
        message: evaluated.message,
        trip_id: evaluated.trip_id ?? null,
      }, 409);
    }
    return json({
      dry_run: true,
      live_execution_disabled: false,
      version_contract: "v2-dry-run-or-confirmed-credit",
      actor_user_id: gate.userId,
      allowlist_size: FIVE_HISTORICAL_MISSING_TEN_IDS.length,
      eligible_trip_count: evaluated.trips.length,
      trips: evaluated.trips,
      proposed_total_pence: evaluated.proposed_total_pence,
      credited_total_pence: 0,
      provider_operation_required: false,
      settlement_recalculation_required: false,
      money_mutation: "ZERO",
      mk_260817_008_excluded: true,
    });
  }

  // Approved live path
  if (!isApprovedLiveExecute(body)) {
    return json({
      error: LIVE_EXECUTION_DISABLED,
      message: `live credit requires dry_run:false and confirm_execute:\"${CONFIRM_EXECUTE_PHRASE}\"`,
    }, 400);
  }

  const result = await executeFiveTripCredit(admin, allow.trip_ids);
  const httpOk = result.failed_count === 0;
  return json({
    dry_run: false,
    confirm_execute: CONFIRM_EXECUTE_PHRASE,
    version_contract: "v2-confirmed-credit",
    actor_user_id: gate.userId,
    trips: result.trips,
    credited_trip_count: result.credited_count,
    already_credited_count: result.already_credited_count,
    failed_count: result.failed_count,
    credited_total_pence: result.credited_total_pence,
    provider_operation_required: false,
    settlement_recalculation_required: false,
    mk_260817_008_excluded: true,
  }, httpOk ? 200 : 409);
});
