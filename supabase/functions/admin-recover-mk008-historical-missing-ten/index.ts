/**
 * Temporary one-trip recovery: MK-260817-008 accepted-offer TEN 609p.
 * Confirm: CREDIT_MK008_ACCEPTED_OFFER_EARNINGS_609P
 * Never mutates trips / Payment Sessions. Delete after verification.
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { corsHeaders as adminCors } from "../_shared/adminPaymentGate.ts";
import {
  CONFIRM_EXECUTE_PHRASE,
  creditMk008Once,
  evaluateMk008DryRun,
  gateExactMk008TripId,
  isApprovedLiveExecute,
  isLiveExecutionRequest,
  LIVE_EXECUTION_DISABLED,
  MK008_APPROVED_PENCE,
  MK008_TRIP_CODE,
} from "../_shared/mk008HistoricalMissingTenCreditSSOT.ts";

const corsHeaders = { ...adminCors, "Content-Type": "application/json" };

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
  if (token === serviceKey) return { ok: true, userId: "service-role" };
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
    return { ok: false, response: json({ success: false, error: "Forbidden — Super Admin required" }, 403) };
  }
  return { ok: true, userId: user.id };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

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

  const allow = gateExactMk008TripId(body.trip_ids);
  if (!allow.ok) return json({ error: allow.error, message: allow.message }, 400);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  if (body.dry_run === true) {
    const evaluated = await evaluateMk008DryRun(admin);
    if (!evaluated.ok) {
      return json({ error: evaluated.error, message: evaluated.message }, 409);
    }
    return json({
      dry_run: true,
      trip_code: MK008_TRIP_CODE,
      actor_user_id: gate.userId,
      ...evaluated,
      proposed_total_pence: MK008_APPROVED_PENCE,
      credited_total_pence: 0,
    });
  }

  if (!isApprovedLiveExecute(body)) {
    return json({
      error: LIVE_EXECUTION_DISABLED,
      message: `live credit requires dry_run:false and confirm_execute:\"${CONFIRM_EXECUTE_PHRASE}\"`,
    }, 400);
  }

  const result = await creditMk008Once(admin);
  const ok = result.status === "CREDITED" || result.status === "ALREADY_CREDITED";
  return json({
    dry_run: false,
    confirm_execute: CONFIRM_EXECUTE_PHRASE,
    trip_code: MK008_TRIP_CODE,
    trip_id: allow.trip_id,
    ...result,
    credited_total_pence: result.credited_pence,
    provider_operation_required: false,
    settlement_recalculation_required: false,
    trip_stamp_mutation: "NONE",
    payment_session_mutation: "NONE",
  }, ok ? 200 : 409);
});
