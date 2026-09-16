/**
 * Admin: Reject / Disable a saved driver payout destination.
 * A8B28F Stage B3: action "verify" → 403 ADMIN_MANUAL_VERIFY_FORBIDDEN.
 * Never writes MANUAL_VERIFIED / PROVIDER_VERIFIED / provider refs / verified_at.
 * No Revolut API calls. No wallet/payout mutation.
 *
 * POST body:
 *   { action: "verify" | "reject" | "disable", destination_id?: string, driver_id?: string }
 *
 * Auth: Authorization Bearer JWT + assert_finance_payout_ledger_access (same finance
 * model as B1). Actor is always auth.uid() — never body actor/role / profiles.role /
 * JWT user-metadata claims. Service-role client only after auth+ACL (and never for verify).
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

function statusForOperationalAction(action: "reject" | "disable"): string {
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
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    const token = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!token) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    // Authenticate with the caller's JWT (no service-role yet).
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });

    const { data: { user }, error: userError } = await userClient.auth.getUser(token);
    if (userError || !user) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: corsHeaders,
      });
    }

    // Finance payout-ledger ACL (B1 model). Rejects ordinary users / inactive staff /
    // staff without company-funds page access. Does not trust body actor/role.
    const { error: aclError } = await userClient.rpc("assert_finance_payout_ledger_access");
    if (aclError) {
      return new Response(
        JSON.stringify({
          error: "forbidden",
          code: "FINANCE_PAYOUT_LEDGER_ACCESS_DENIED",
          message: "Finance payout-ledger access required.",
        }),
        { status: 403, headers: corsHeaders },
      );
    }

    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    // Ignore any client-supplied actor/role/user_id — JWT + ACL are authoritative.
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

    // Manual verification is permanently forbidden — before any destination read/write
    // and before service-role client creation / provider work.
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

    // Service-role only after auth+ACL, and only for operational reject/disable.
    const supabase = createClient(
      supabaseUrl,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

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
        "id, driver_id, provider, destination_last4, masked_sort_code, masked_account_number, destination_label, verification_status, destination_payload, is_active, provider_link_status",
      )
      .eq("is_active", true)
      .is("archived_at", null);

    if (destinationId) query = query.eq("id", destinationId);
    else {
      query = query
        .eq("driver_id", driverId!)
        .order("updated_at", { ascending: false })
        .limit(1);
    }

    const { data: row, error: loadError } = await query.maybeSingle();
    if (loadError || !row?.id) {
      return new Response(JSON.stringify({ error: "destination_not_found" }), {
        status: 404,
        headers: corsHeaders,
      });
    }

    const now = new Date().toISOString();
    const nextStatus = statusForOperationalAction(action);
    const previousPayload = (row.destination_payload && typeof row.destination_payload === "object")
      ? row.destination_payload as Record<string, unknown>
      : {};

    // Operational reject/disable only — never touch provider refs / verified_at /
    // PROVIDER_VERIFIED / MANUAL_VERIFIED.
    const updateFields: Record<string, unknown> = {
      verification_status: nextStatus,
      updated_at: now,
      is_active: false,
      destination_payload: {
        ...previousPayload,
        verification_status: nextStatus,
        admin_action: action,
        // Store actor as JWT subject only (no role spoof from body).
        actor_user_id: user.id,
      },
    };
    if (action === "disable") updateFields.archived_at = now;

    const { data: updated, error: updateError } = await supabase
      .from("driver_payout_destinations")
      .update(updateFields)
      .eq("id", row.id)
      .select(
        "id, driver_id, provider, destination_label, destination_last4, masked_sort_code, masked_account_number, verification_status, is_active, provider_link_status",
      )
      .maybeSingle();

    if (updateError || !updated) {
      console.error("ADMIN_DESTINATION_OPERATIONAL_UPDATE_FAILED");
      return new Response(JSON.stringify({ error: "update_failed" }), {
        status: 500,
        headers: corsHeaders,
      });
    }

    // Lock: reject/disable must never invent MANUAL_VERIFIED or provider verification.
    const updatedStatus = String(updated.verification_status ?? "").toUpperCase();
    if (updatedStatus === "MANUAL_VERIFIED" || updatedStatus === "PROVIDER_VERIFIED") {
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
        destination_last4: row.destination_last4,
      },
      new_payload: {
        verification_status: nextStatus,
        admin_action: action,
      },
      changed_by_user_id: user.id,
      old_payout_account_id: row.id,
      new_payout_account_id: row.id,
      changed_by_role: "admin",
      metadata: {
        revolut_called: false,
        wallet_mutated: false,
        provider_mutated: false,
        manual_verify: false,
        admin_action: action,
      },
    });

    return new Response(
      JSON.stringify({
        success: true,
        action,
        destination: {
          id: updated.id,
          driver_id: updated.driver_id,
          provider: updated.provider,
          destination_label: updated.destination_label,
          destination_last4: updated.destination_last4,
          masked_sort_code: updated.masked_sort_code,
          masked_account_number: updated.masked_account_number,
          verification_status: updated.verification_status,
          is_active: updated.is_active,
          // Intentionally omit provider refs / verified_at / verified_by.
        },
        verification_status: nextStatus,
        eligibility: {
          destination_saved: false,
          destination_manually_verified: false,
          destination_provider_linked: false,
          automatic_api_payout_ready: false,
        },
        revolut_called: false,
        wallet_mutated: false,
        payout_executed: false,
      }),
      { status: 200, headers: corsHeaders },
    );
  } catch (_error) {
    console.error("ADMIN_VERIFY_DRIVER_PAYOUT_DESTINATION_FAILED");
    return new Response(JSON.stringify({ error: "internal_error" }), {
      status: 500,
      headers: corsHeaders,
    });
  }
});
