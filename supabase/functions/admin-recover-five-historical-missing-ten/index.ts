/**
 * Temporary Step 9.2C1 dry-run-only recovery probe.
 * Slug: admin-recover-five-historical-missing-ten
 *
 * v1: LIVE EXECUTION DISABLED — no TEN insert, no wallet/PS/provider/FR repair writes.
 * Delete after recovery programme completes.
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { corsHeaders as adminCors } from "../_shared/adminPaymentGate.ts";
import {
  ALLOWLIST_VIOLATION,
  evaluateFiveTripDryRun,
  FIVE_HISTORICAL_MISSING_TEN_IDS,
  gateExactFiveTripAllowlist,
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

/** Super Admin (user_roles.admin) or exact Edge service-role key. Staff-only rejected. */
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

  // Ignore any actor/role fields supplied in the body (auth is header JWT only).
  delete body.actor;
  delete body.actor_id;
  delete body.actor_role;
  delete body.role;
  delete body.user_id;

  if (isLiveExecutionRequest(body)) {
    return json({
      error: LIVE_EXECUTION_DISABLED,
      message: "v1 is dry-run only; live TEN credit is not enabled",
      dry_run_required: true,
    }, 400);
  }

  if (body.dry_run !== true) {
    return json({
      error: LIVE_EXECUTION_DISABLED,
      message: 'v1 requires dry_run:true exactly',
    }, 400);
  }

  const allow = gateExactFiveTripAllowlist(body.trip_ids);
  if (!allow.ok) {
    return json({ error: allow.error, message: allow.message }, 400);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

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
    live_execution_disabled: true,
    function: "admin-recover-five-historical-missing-ten",
    version_contract: "v1-dry-run-only",
    actor_user_id: gate.userId,
    allowlist_size: FIVE_HISTORICAL_MISSING_TEN_IDS.length,
    eligible_trip_count: evaluated.trips.length,
    trips: evaluated.trips,
    proposed_total_pence: evaluated.proposed_total_pence,
    credited_total_pence: evaluated.credited_total_pence,
    provider_operation_required: evaluated.provider_operation_required,
    settlement_recalculation_required: evaluated.settlement_recalculation_required,
    money_mutation: evaluated.money_mutation,
    mk_260817_008_excluded: true,
  });
});
