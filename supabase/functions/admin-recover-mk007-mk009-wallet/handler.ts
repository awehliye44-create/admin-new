/**
 * Temporary Step 4F.1 dry-run recovery for MK-260817-007 and MK-260817-009.
 *
 * Live execution is disabled. Super Admin or cryptographically verified
 * service-role only. UUID-array input only. No provider / FR / payout /
 * Commission Wallet / settlement-recalculation ownership.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, jsonResponse, type GateResult } from "../_shared/adminPaymentGate.ts";
import {
  APPROVED_MK007_MK009_TRIP_IDS,
  RECOVERY_AUDIT_REASON,
  recoverMk007Mk009WalletDryRun,
  type RecoveryResult,
} from "./mk007Mk009WalletRecovery.ts";
import {
  authenticateRecoverBearer,
  extractBearerToken,
  FORBIDDEN_AUTH_BODY_KEYS,
  PRODUCTION_PROJECT_REF,
} from "./recoverAuth.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const FORBIDDEN_COHORT_KEYS = [
  "from",
  "to",
  "date_from",
  "date_to",
  "period",
  "cohort",
  "after",
  "before",
  "all",
  "trip_codes",
  "date_range",
  "completed_after",
  "completed_before",
  "all_driver",
  "all_drivers",
  "driver_id",
] as const;

export type RecoverAuthClassification =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "ALLOWED";

/** Pure auth matrix — Super Admin staff role or service-role only. */
export function classifyRecoverAuthorization(input: {
  hasBearer: boolean;
  tokenMatchesServiceRole: boolean;
  userFound: boolean;
  staffRole: string | null;
}): RecoverAuthClassification {
  if (!input.hasBearer) return "UNAUTHENTICATED";
  if (input.tokenMatchesServiceRole) return "ALLOWED";
  if (!input.userFound) return "UNAUTHENTICATED";
  if (String(input.staffRole ?? "").trim() === "super_admin") return "ALLOWED";
  return "FORBIDDEN";
}

function projectRefFromUrl(supabaseUrl: string): string {
  return supabaseUrl.match(/https:\/\/([a-z0-9]+)\.supabase\.co/i)?.[1]
    ?? PRODUCTION_PROJECT_REF;
}

async function platformVerifyServiceRoleJwt(token: string): Promise<boolean> {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  if (!url) return false;
  const client = createClient(url, token, { auth: { persistSession: false } });
  const { error } = await client.auth.admin.listUsers({ page: 1, perPage: 1 });
  return !error;
}

export async function requireSuperAdminOrServiceRole(
  req: Request,
): Promise<GateResult | { ok: false; response: Response }> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL") ?? "";
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const jwtSecret = Deno.env.get("SUPABASE_JWT_SECRET") ?? Deno.env.get("JWT_SECRET") ?? "";
  const token = extractBearerToken(req);

  const auth = await authenticateRecoverBearer(
    token,
    {
      serviceRoleKey: supabaseServiceKey,
      anonKey: Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      jwtSecret,
      projectRef: projectRefFromUrl(supabaseUrl),
    },
    {
      platformVerifyServiceRoleJwt,
      getUser: async (userToken) => {
        const supabase = createClient(supabaseUrl, supabaseServiceKey, {
          auth: { persistSession: false },
        });
        const { data: { user }, error } = await supabase.auth.getUser(userToken);
        if (error || !user?.id) return null;
        return { id: user.id };
      },
      loadSuperAdmin: async (userId) => {
        const supabase = createClient(supabaseUrl, supabaseServiceKey, {
          auth: { persistSession: false },
        });
        const { data: staffRow } = await supabase
          .from("staff_profiles")
          .select("role, is_active")
          .eq("user_id", userId)
          .eq("is_active", true)
          .maybeSingle();
        if (String(staffRow?.role ?? "").trim() === "super_admin") return true;
        const { data: roleRow } = await supabase
          .from("user_roles")
          .select("role")
          .eq("user_id", userId)
          .eq("role", "super_admin")
          .maybeSingle();
        return Boolean(roleRow);
      },
    },
  );

  if (!auth.ok) {
    return {
      ok: false,
      response: jsonResponse({ success: false, error: auth.error, code: auth.code }, auth.status),
    };
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  });
  return { ok: true, supabase, userId: auth.userId };
}

export async function handleAdminRecoverMk007Mk009Wallet(
  req: Request,
  deps?: {
    authorize?: (req: Request) => Promise<GateResult | { ok: false; response: Response }>;
    recover?: typeof recoverMk007Mk009WalletDryRun;
  },
): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "POST required" }, 405);
  }

  try {
    const authorize = deps?.authorize ?? requireSuperAdminOrServiceRole;
    const recover = deps?.recover ?? recoverMk007Mk009WalletDryRun;
    const gate = await authorize(req);
    if (!gate.ok) return gate.response;

    let body: Record<string, unknown> = {};
    try {
      const parsed = await req.json();
      body = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    } catch {
      return jsonResponse({ success: false, error: "Invalid JSON body" }, 400);
    }

    for (const key of FORBIDDEN_COHORT_KEYS) {
      if (body[key] != null) {
        return jsonResponse({
          success: false,
          error: "Cohort / date-range / all-driver recovery is forbidden. Pass explicit trip_ids only.",
          code: "COHORT_MODE_FORBIDDEN",
        }, 400);
      }
    }

    for (const key of FORBIDDEN_AUTH_BODY_KEYS) {
      if (body[key] != null) {
        return jsonResponse({
          success: false,
          error: "Caller identity must not be supplied in the request body",
          code: "AUTH_CLAIM_IN_BODY",
        }, 403);
      }
    }

    if (body.confirm_execute != null) {
      return jsonResponse({
        success: false,
        error: "Live execution is disabled. No confirmation phrase is accepted.",
        code: "LIVE_EXECUTION_DISABLED",
      }, 403);
    }

    if (body.dry_run === false) {
      return jsonResponse({
        success: false,
        error: "Live execution is disabled for this temporary recovery function.",
        code: "LIVE_EXECUTION_DISABLED",
      }, 403);
    }
    if (body.dry_run != null && body.dry_run !== true) {
      return jsonResponse({
        success: false,
        error: "dry_run must be true or omitted",
        code: "INVALID_DRY_RUN",
      }, 400);
    }

    const tripIdsRaw = body.trip_ids;
    if (!Array.isArray(tripIdsRaw) || tripIdsRaw.length === 0) {
      return jsonResponse({
        success: false,
        error: "trip_ids must be a non-empty array of UUIDs",
      }, 400);
    }

    const tripIds: string[] = [];
    for (const raw of tripIdsRaw) {
      const id = String(raw ?? "").trim();
      if (!UUID_RE.test(id)) {
        return jsonResponse({
          success: false,
          error: `Invalid trip UUID: ${id || "(empty)"}`,
        }, 400);
      }
      tripIds.push(id);
    }

    const allowList = [...APPROVED_MK007_MK009_TRIP_IDS];
    const unknown = tripIds.filter((id) => !allowList.includes(id));
    if (unknown.length > 0) {
      return jsonResponse({
        success: false,
        error: "Request contains trip UUIDs outside the approved allow-list. Entire request blocked.",
        code: "ALLOW_LIST_VIOLATION",
        unknown_trip_ids: unknown,
      }, 400);
    }

    const results: RecoveryResult[] = [];
    for (const tripId of tripIds) {
      results.push(await recover(gate.supabase, tripId));
    }

    const eligible = results.filter((row) => row.status === "DRY_RUN_ELIGIBLE");
    const proposedTotalPence = eligible.reduce(
      (sum, row) => sum + (row.status === "DRY_RUN_ELIGIBLE" ? row.proposed_amount_pence : 0),
      0,
    );

    const audit = {
      actor_admin_uuid: gate.userId,
      allow_list: allowList,
      trip_ids: tripIds,
      reason: RECOVERY_AUDIT_REASON,
      dry_run: true,
      timestamp: new Date().toISOString(),
      provider_operation: false,
      proposed_total_pence: proposedTotalPence,
      results: results.map((row) => ({
        trip_id: row.tripId,
        trip_code: row.tripCode,
        status: row.status,
        before_wallet_count: row.status === "DRY_RUN_ELIGIBLE" ? row.existing_wallet_count : null,
        before_wallet_amount_pence: row.status === "DRY_RUN_ELIGIBLE"
          ? row.existing_wallet_amount_pence
          : (row.status === "ALREADY_CREDITED" ? row.credited_pence : null),
        proposed_amount_pence: row.status === "DRY_RUN_ELIGIBLE" ? row.proposed_amount_pence : null,
        payment_session_id: row.status === "DRY_RUN_ELIGIBLE" ? row.payment_session_id : null,
        provider_capture_id: row.status === "DRY_RUN_ELIGIBLE" ? row.provider_capture_id : null,
      })),
    };

    console.log("[admin-recover-mk007-mk009-wallet]", JSON.stringify(audit));

    return jsonResponse({
      success: true,
      dry_run: true,
      proposed_total_pence: proposedTotalPence,
      provider_operation_required: false,
      settlement_recalculation_required: false,
      results,
      audit,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[admin-recover-mk007-mk009-wallet] failed", message);
    return jsonResponse({ success: false, error: message }, 500);
  }
}
