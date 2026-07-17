/**
 * Admin get/set Commission Wallet Phase 3 test access.
 * Page-gated; uses service role so finance staff (not only JWT admin) can read/toggle.
 * Omit `enabled` to read; pass boolean `enabled` to write.
 * Never writes ledgers.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import {
  requireAdminOrStaff,
  requirePageAccess,
  corsHeaders,
} from "../_shared/adminPaymentGate.ts";

const PAGE_SLUG = "commission-wallet";

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const staffGate = await requireAdminOrStaff(req);
    if (!staffGate.ok) return staffGate.response;
    const gate = await requirePageAccess(staffGate, PAGE_SLUG);
    if (!gate.ok) return gate.response;

    if (gate.userId === "service-role" || !/^[0-9a-f-]{36}$/i.test(gate.userId)) {
      return json({
        success: false,
        error: "Authenticated admin/staff user required for Commission Wallet test access",
        code: "ADMIN_USER_REQUIRED",
      }, 403);
    }

    const body = await req.json().catch(() => ({})) as {
      driver_id?: string;
      enabled?: boolean;
    };

    const driverId = String(body.driver_id ?? "").trim();
    if (!driverId || !/^[0-9a-f-]{36}$/i.test(driverId)) {
      return json({ success: false, error: "driver_id required (uuid)" }, 400);
    }

    // Read path (finance_manager cannot SELECT drivers via RLS).
    if (typeof body.enabled !== "boolean") {
      const { data, error } = await gate.supabase
        .from("drivers")
        .select("id, commission_wallet_test_access")
        .eq("id", driverId)
        .maybeSingle();

      if (error) {
        return json({ success: false, error: error.message }, 400);
      }
      if (!data) {
        return json({ success: false, error: "Driver not found", code: "DRIVER_NOT_FOUND" }, 404);
      }

      return json({
        success: true,
        phase: 3,
        op: "get",
        driver_id: data.id,
        commission_wallet_test_access: Boolean(data.commission_wallet_test_access),
      });
    }

    const { data, error } = await gate.supabase
      .from("drivers")
      .update({
        commission_wallet_test_access: body.enabled,
        updated_at: new Date().toISOString(),
      })
      .eq("id", driverId)
      .select("id, commission_wallet_test_access")
      .maybeSingle();

    if (error) {
      return json({ success: false, error: error.message }, 400);
    }
    if (!data) {
      return json({ success: false, error: "Driver not found", code: "DRIVER_NOT_FOUND" }, 404);
    }

    return json({
      success: true,
      phase: 3,
      op: "set",
      driver_id: data.id,
      commission_wallet_test_access: Boolean(data.commission_wallet_test_access),
      updated_by: gate.userId,
    });
  } catch (e) {
    console.error("admin-set-commission-wallet-test-access", e);
    return json({
      success: false,
      error: e instanceof Error ? e.message : "Internal error",
    }, 500);
  }
});
