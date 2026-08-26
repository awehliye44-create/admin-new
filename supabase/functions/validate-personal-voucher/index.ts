/**
 * validate-personal-voucher — Customer JWT.
 *
 * Actions:
 * - list: valid unused personal vouchers for the signed-in rider
 * - validate: resolve discount for a code + fare (backend SSOT)
 *
 * Does not consume/reserve vouchers — consumption happens at trip create.
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { handleCORSPreflight } from "../_shared/security.ts";
import {
  PERSONAL_VOUCHER_ERROR_MESSAGES,
  calcDiscountPence,
  resolvePersonalVoucherForTrip,
  validatePersonalVoucherRow,
  type PersonalVoucherRow,
} from "../_shared/resolve-personal-voucher.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const jsonHeaders = {
  ...corsHeaders,
  "Content-Type": "application/json",
};

function json(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleCORSPreflight();

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return json({ success: false, error: "auth", message: "Please sign in again." }, 401);
    }

    const supabaseAuth = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userError } = await supabaseAuth.auth.getUser();
    if (userError || !userData.user) {
      return json({ success: false, error: "auth", message: "Please sign in again." }, 401);
    }

    const admin = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false },
    });

    const { data: customer, error: customerError } = await admin
      .from("customers")
      .select("id")
      .eq("user_id", userData.user.id)
      .maybeSingle();

    if (customerError || !customer?.id) {
      return json({
        success: false,
        error: "customer",
        message: "Customer profile not found.",
      }, 400);
    }
    const customerId = String(customer.id);

    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const action = typeof body.action === "string" ? body.action.trim().toLowerCase() : "validate";
    const farePence = Math.max(
      0,
      Math.floor(Number(body.fare_pence ?? body.estimated_fare_pence) || 0),
    );

    if (action === "list") {
      const { data, error } = await admin
        .from("customer_personal_vouchers")
        .select(
          "id,customer_id,code,discount_type,discount_value,min_fare,max_uses,used_count,expires_at,is_active",
        )
        .eq("customer_id", customerId)
        .eq("is_active", true)
        .order("created_at", { ascending: false });

      if (error) {
        console.warn("[validate-personal-voucher] list failed", error.message);
        return json({ success: false, error: "db", message: "Unable to load vouchers." }, 500);
      }

      // List only vouchers that are assigned, active, unused, and not expired.
      // When fare_pence is provided, also enforce min fare so ineligible codes stay hidden.
      const listFarePence = farePence > 0 ? farePence : Number.MAX_SAFE_INTEGER;
      const vouchers = ((data ?? []) as PersonalVoucherRow[])
        .filter((row) =>
          validatePersonalVoucherRow(row, { customerId, farePence: listFarePence }) === null
        )
        .map((row) => {
          const preview = farePence > 0 ? calcDiscountPence(row, farePence) : null;
          return {
            id: row.id,
            code: row.code,
            discount_type: row.discount_type,
            discount_value: row.discount_value,
            min_fare: row.min_fare,
            expires_at: row.expires_at,
            preview_discount_pence: preview,
            preview_final_fare_pence:
              preview != null ? Math.max(0, farePence - preview) : null,
          };
        });

      return json({ success: true, vouchers });
    }

    const code = typeof body.code === "string" ? body.code.trim() : "";
    if (!code) {
      return json({
        success: false,
        error: "empty",
        message: "Enter a voucher or promo code.",
      }, 400);
    }
    if (farePence <= 0) {
      return json({
        success: false,
        error: "fare",
        message: "Choose a ride before applying a voucher.",
      }, 400);
    }

    const resolved = await resolvePersonalVoucherForTrip({
      admin,
      code,
      customerId,
      estimatedFarePence: farePence,
    });
    if (!resolved.ok) {
      return json({
        success: false,
        valid: false,
        error: PERSONAL_VOUCHER_ERROR_MESSAGES[resolved.error],
        code: resolved.error,
        message: PERSONAL_VOUCHER_ERROR_MESSAGES[resolved.error],
      }, 400);
    }

    return json({
      success: true,
      valid: true,
      voucher_id: resolved.resolved.voucherId,
      code: resolved.resolved.voucherCode,
      discount_pence: resolved.resolved.discountPence,
      final_fare_pence: resolved.resolved.finalFarePence,
      resolved: {
        voucher_id: resolved.resolved.voucherId,
        voucher_code: resolved.resolved.voucherCode,
        discount_pence: resolved.resolved.discountPence,
        final_fare_pence: resolved.resolved.finalFarePence,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[validate-personal-voucher]", message);
    return json({ success: false, error: "server", message: "Unable to validate voucher." }, 500);
  }
});
