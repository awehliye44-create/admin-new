import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function getResendApiKey(): string | undefined {
  const raw = Deno.env.get("RESEND_API_KEY");
  if (!raw) return undefined;
  const trimmed = raw.trim().replace(/^["']|["']$/g, "");
  return trimmed || undefined;
}

async function fetchResend(path: string, apiKey: string) {
  const response = await fetch(`https://api.resend.com${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const payload = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, payload };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization") ?? "";
    const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : authHeader;
    const role = bearer.split(".")[1]
      ? JSON.parse(atob(bearer.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"))).role
      : null;
    if (role !== "service_role") {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const targetEmail = typeof body.email === "string" ? body.email : "bookings@onecab.net";
    const emailIds = Array.isArray(body.email_ids) ? body.email_ids.filter((id: unknown) => typeof id === "string") : [];

    const apiKey = getResendApiKey();
    if (!apiKey) {
      return new Response(JSON.stringify({ error: "RESEND_API_KEY not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const fromEmail = (Deno.env.get("RESEND_FROM_EMAIL") ?? "").trim().replace(/^["']|["']$/g, "");
    const replyTo = (Deno.env.get("RESEND_REPLY_TO_EMAIL") ?? "").trim().replace(/^["']|["']$/g, "");

    const domains = await fetchResend("/domains", apiKey);
    const recentEmails = await fetchResend("/emails?limit=20", apiKey);

    const emailDetails: Array<Record<string, unknown>> = [];
    for (const id of emailIds) {
      const detail = await fetchResend(`/emails/${id}`, apiKey);
      emailDetails.push({ id, ...detail });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? bearer;
    const service = createClient(supabaseUrl, serviceKey);
    const { data: verifications } = await service
      .from("account_email_verifications")
      .select("id, email, app_type, created_at, verified_at, expires_at")
      .ilike("email", targetEmail)
      .order("created_at", { ascending: false })
      .limit(10);

    return new Response(
      JSON.stringify({
        ok: true,
        config: {
          from_email: fromEmail || null,
          reply_to: replyTo || null,
        },
        domains: domains.payload,
        recent_emails: recentEmails.payload,
        email_details: emailDetails,
        account_email_verifications: verifications ?? [],
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    console.error("investigate-resend-delivery error:", err);
    return new Response(JSON.stringify({ error: "Internal server error", detail: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
