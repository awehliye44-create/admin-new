/**
 * Action-level RBAC helper — reuses public.staff_has_action (Owner always allowed).
 * Missing role_action_permissions row = deny. Do not grant from page access alone.
 */
import { corsHeaders, type GateError, type GateResult } from "./adminPaymentGate.ts";

export async function requireStaffAction(
  gate: GateResult,
  actionKey: string,
): Promise<GateResult | GateError> {
  const key = String(actionKey ?? "").trim();
  if (!key) {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ error: "Forbidden — action key required", code: "ACTION_KEY_REQUIRED" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      ),
    };
  }

  const { data: allowed, error } = await gate.supabase.rpc("staff_has_action", {
    _user_id: gate.userId,
    _action_key: key,
  });

  if (error || !allowed) {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({
          error: `Forbidden — ${key} required`,
          code: "ACTION_PERMISSION_DENIED",
          action_key: key,
        }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      ),
    };
  }

  return gate;
}
