/**
 * A8B28F Stage B3 — Admin verify prohibition (drop-in).
 * Copy to: supabase/functions/admin-verify-driver-payout-destination/index.ts
 *
 * - action "verify" → 403 ADMIN_MANUAL_VERIFY_FORBIDDEN (no DB write)
 * - never writes MANUAL_VERIFIED / PROVIDER_VERIFIED / provider refs / verified_at
 * - reject/disable remain operational destination controls (not provider verification)
 * - Auth: active staff with payout-ledger company-funds access via assert RPC preferred;
 *   JWT user required; no profiles.role / metadata-role / caller-supplied actor.
 * NOT DEPLOYED. No Revolut calls.
 */

import { createClient } from "npm:@supabase/supabase-js@2";
import { DESTINATION_STATUS } from "../_shared/driverPayoutDestinationSSOT.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Content-Type": "application/json",
};

type AdminDestinationAction = "verify" | "reject" | "disable";

function statusForAction(action: Exclude<AdminDestinationAction, "verify">): string {
  if (action === "reject") return DESTINATION_STATUS.REJECTED;
  return DESTINATION_STATUS.DISABLED;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method_not_allowed" }), {
      status: 405,
      headers: corsHeaders,
    });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    // Prefer established finance page ACL over coarse user_roles-only.
    // Call as the user JWT so assert_finance_payout_ledger_access sees auth.uid().
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { error: aclError } = await userClient.rpc("assert_finance_payout_ledger_access");
    if (aclError) {
      return new Response(JSON.stringify({ error: "forbidden", code: "42501" }), {
        status: 403,
        headers: corsHeaders,
      });
    }

    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const rawAction = typeof body.action === "string" ? body.action.trim().toLowerCase() : "verify";
    const action = (rawAction === "reject" || rawAction === "disable" || rawAction === "verify")
      ? rawAction as AdminDestinationAction
      : null;

    if (!action) {
      return new Response(JSON.stringify({ error: "invalid_action" }), {
        status: 400,
        headers: corsHeaders,
      });
    }

    if (action === "verify") {
      return new Response(
        JSON.stringify({
          success: false,
          error: "ADMIN_MANUAL_VERIFY_FORBIDDEN",
          message:
            "Admin cannot manually verify payout destinations. Provider verification is required.",
        }),
        { status: 403, headers: corsHeaders },
      );
    }

    const destinationId = typeof body.destination_id === "string" ? body.destination_id : null;
    const driverId = typeof body.driver_id === "string" ? body.driver_id : null;
    if (!destinationId && !driverId) {
      return new Response(
        JSON.stringify({ error: "destination_id_or_driver_id_required" }),
        { status: 400, headers: corsHeaders },
      );
    }

    let query = supabase
      .from("driver_payout_destinations")
      .select(
        "id, driver_id, provider, destination_last4, masked_sort_code, masked_account_number, destination_label, verification_status, destination_payload, is_active, provider_link_status, provider_counterparty_id, provider_recipient_account_id, verified_at",
      )
      .eq("is_active", true)
      .is("archived_at", null);

    if (destinationId) query = query.eq("id", destinationId);
    else {
      query = query.eq("driver_id", driverId!).order("updated_at", { ascending: false }).limit(1);
    }

    const { data: row, error: loadError } = await query.maybeSingle();
    if (loadError || !row?.id) {
      return new Response(JSON.stringify({ error: "destination_not_found" }), {
        status: 404,
        headers: corsHeaders,
      });
    }

    const now = new Date().toISOString();
    const nextStatus = statusForAction(action);
    const previousPayload = (row.destination_payload && typeof row.destination_payload === "object")
      ? row.destination_payload as Record<string, unknown>
      : {};

    // Operational reject/disable only — never touch provider refs / verified_at / PROVIDER_VERIFIED.
    const updateFields: Record<string, unknown> = {
      verification_status: nextStatus,
      updated_at: now,
      is_active: false,
      destination_payload: {
        ...previousPayload,
        verification_status: nextStatus,
        admin_action: action,
        actor_user_id: user.id,
      },
    };
    if (action === "disable") updateFields.archived_at = now;

    const { data: updated, error: updateError } = await supabase
      .from("driver_payout_destinations")
      .update(updateFields)
      .eq("id", row.id)
      .select(
        "id, verification_status, provider_link_status, provider_counterparty_id, provider_recipient_account_id, verified_at, is_active",
      )
      .maybeSingle();

    if (updateError || !updated) {
      return new Response(JSON.stringify({ error: "update_failed" }), {
        status: 500,
        headers: corsHeaders,
      });
    }

    // Lock: reject/disable must never invent MANUAL_VERIFIED or provider verification.
    if (
      String(updated.verification_status).toUpperCase() === "MANUAL_VERIFIED" ||
      String(updated.verification_status).toUpperCase() === "PROVIDER_VERIFIED"
    ) {
      return new Response(JSON.stringify({ error: "invariant_violation" }), {
        status: 500,
        headers: corsHeaders,
      });
    }

    await supabase.from("driver_payout_destination_audit").insert({
      driver_id: row.driver_id,
      provider: row.provider,
      action: `admin_${action}`,
      previous_payload: {
        verification_status: row.verification_status,
        provider_link_status: row.provider_link_status,
      },
      new_payload: {
        verification_status: nextStatus,
        admin_action: action,
      },
      changed_by_user_id: user.id,
      changed_by_role: "admin",
      new_payout_account_id: row.id,
      metadata: { provider_mutated: false, manual_verify: false },
    });

    return new Response(
      JSON.stringify({
        success: true,
        action,
        destination_id: updated.id,
        verification_status: updated.verification_status,
      }),
      { status: 200, headers: corsHeaders },
    );
  } catch (_err) {
    return new Response(JSON.stringify({ error: "internal_error" }), {
      status: 500,
      headers: corsHeaders,
    });
  }
});
