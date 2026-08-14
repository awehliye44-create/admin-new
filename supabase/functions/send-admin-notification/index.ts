import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { sendAdminNotification } from "../_shared/adminNotificationSSOT.ts";
import { assertCronOrServiceRoleAuth, cronAuthCorsHeaders } from "../_shared/cronEdgeAuth.ts";

const corsHeaders = cronAuthCorsHeaders;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    let body: Record<string, unknown> = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const auth = await assertCronOrServiceRoleAuth(req, body);
    if (!auth.ok) return auth.response;

    const type = String(body.type ?? "").trim();
    const title = String(body.title ?? "").trim();
    const messageBody = String(body.body ?? body.message ?? "").trim();
    if (!type || !title || !messageBody) {
      return new Response(JSON.stringify({
        success: false,
        error: "type, title, and body are required",
      }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      { auth: { persistSession: false } },
    );

    const result = await sendAdminNotification(supabase, {
      type,
      title,
      body: messageBody,
      category: (body.category as "payment" | "system" | "trip" | undefined) ?? "payment",
      priority: (body.priority as "low" | "normal" | "high" | "urgent" | undefined) ?? "urgent",
      actionUrl: body.action_url ? String(body.action_url) : undefined,
      actionLabel: body.action_label ? String(body.action_label) : undefined,
      data: (body.data as Record<string, unknown> | undefined) ?? undefined,
      alertKey: body.alert_key ? String(body.alert_key) : undefined,
      cooldownMinutes: body.cooldown_minutes != null ? Number(body.cooldown_minutes) : undefined,
      emailTag: body.email_tag ? String(body.email_tag) : undefined,
    });

    return new Response(JSON.stringify({ success: true, ...result }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[send-admin-notification]", err);
    return new Response(JSON.stringify({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
