// Fetches a single Revolut Merchant payment and maps it to the ONECAB
// reconciliation shape. Admin-only. Read-only — does not mutate DB.
//
// POST { payment_id: string, environment?: "live" | "sandbox" }
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";
import {
  getRevolutMerchantPayment,
  mapRevolutPaymentToOnecab,
} from "../_shared/revolutApi.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "missing_auth" }, 401);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return json({ error: "unauthorized" }, 401);

    const admin = createClient(supabaseUrl, serviceKey);
    const { data: roleRow } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", userData.user.id)
      .eq("role", "admin")
      .maybeSingle();
    if (!roleRow) return json({ error: "forbidden" }, 403);

    const body = await req.json().catch(() => ({}));
    const paymentId = typeof body?.payment_id === "string" ? body.payment_id.trim() : "";
    if (!paymentId) return json({ error: "missing_payment_id" }, 400);
    const environment = body?.environment === "sandbox" ? "sandbox" : "live";

    const secretKey = Deno.env.get("REVOLUT_MERCHANT_SECRET_KEY");
    if (!secretKey) return json({ error: "missing_revolut_secret" }, 500);

    const payment = await getRevolutMerchantPayment({
      environment,
      secretKey,
      paymentId,
    });
    return json({ payment: mapRevolutPaymentToOnecab(payment) });
  } catch (err) {
    const anyErr = err as { status?: number; message?: string; body?: unknown };
    return json(
      { error: anyErr?.message ?? "internal_error", details: anyErr?.body ?? null },
      anyErr?.status && anyErr.status >= 400 && anyErr.status < 600 ? anyErr.status : 500,
    );
  }
});

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
