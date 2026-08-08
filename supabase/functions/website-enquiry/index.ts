// Public website enquiry intake (onecab.net contact + driver application forms).
// Honeypot + IP-hash rate limiting + idempotency, emailed via Resend.
import { createClient } from "npm:@supabase/supabase-js@2";
import { z } from "https://esm.sh/zod@3.23.8";
import { sendResendEmail } from "../_shared/resendMail.ts";

const ALLOWED_ORIGINS = new Set([
  "https://onecab.net",
  "https://www.onecab.net",
]);

function corsHeadersFor(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.has(origin) ? origin : "https://onecab.net",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

function json(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersFor(req), "Content-Type": "application/json" },
  });
}

const BodySchema = z.object({
  formType: z.enum(["contact", "driver_application"]),
  idempotencyKey: z.string().trim().min(8).max(200),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(255),
  phone: z.string().trim().max(40).optional(),
  license: z.string().trim().max(120).optional(),
  experience: z.string().trim().max(500).optional(),
  message: z.string().trim().max(4000).optional(),
  source: z.string().trim().max(120).optional(),
  company_website: z.string().max(500).optional(),
});

const RATE_LIMIT = 5;
const RATE_WINDOW_MINUTES = 30;

function clientIp(req: Request): string {
  return (
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    req.headers.get("x-real-ip") ||
    req.headers.get("cf-connecting-ip") ||
    "unknown"
  );
}

async function hashIp(ip: string): Promise<string> {
  const salt = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "onecab";
  const data = new TextEncoder().encode(`${salt}:${ip}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );
}

function buildEmail(data: z.infer<typeof BodySchema>) {
  const isDriver = data.formType === "driver_application";
  const subject = isDriver
    ? `New driver application — ${data.name}`
    : `New website enquiry — ${data.name}`;

  const rows: Array<[string, string | undefined]> = [
    ["Name", data.name],
    ["Email", data.email],
    ["Phone", data.phone],
    ["Licence", data.license],
    ["Experience", data.experience],
    ["Source", data.source],
  ];

  const rowsHtml = rows
    .filter(([, v]) => v && v.length)
    .map(
      ([label, value]) =>
        `<tr><td style="padding:6px 12px 6px 0;color:#64748b;">${label}</td><td style="padding:6px 0;color:#0f172a;"><strong>${escapeHtml(
          value as string,
        )}</strong></td></tr>`,
    )
    .join("");

  const messageHtml = data.message
    ? `<p style="margin:16px 0 0;color:#0f172a;white-space:pre-wrap;">${escapeHtml(data.message)}</p>`
    : "";

  const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:560px;">
    <h2 style="margin:0 0 12px;color:#0f172a;">${escapeHtml(subject)}</h2>
    <table style="border-collapse:collapse;font-size:14px;">${rowsHtml}</table>
    ${messageHtml}
    <p style="margin-top:24px;font-size:12px;color:#94a3b8;">Submitted via onecab.net</p>
  </div>`;

  const text = rows
    .filter(([, v]) => v && v.length)
    .map(([label, value]) => `${label}: ${value}`)
    .concat(data.message ? ["", data.message] : [])
    .join("\n");

  return { subject, html, text };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeadersFor(req) });
  if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return json(req, { error: "Invalid JSON body" }, 400);
  }

  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return json(req, { error: "Validation failed", details: parsed.error.flatten().fieldErrors }, 400);
  }
  const data = parsed.data;

  // Honeypot — silently accept so bots do not learn they were rejected.
  if (data.company_website && data.company_website.trim().length > 0) {
    console.warn("[website-enquiry] honeypot triggered");
    return json(req, { success: true, status: "received" });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const ipHash = await hashIp(clientIp(req));

  // Idempotency — return the prior outcome for a repeated key.
  const { data: existing } = await supabase
    .from("website_enquiries")
    .select("id, email_status")
    .eq("idempotency_key", data.idempotencyKey)
    .maybeSingle();
  if (existing) {
    return json(req, { success: true, status: "duplicate", enquiry_id: existing.id });
  }

  // Rate limit: 5 submissions per IP per 30 minutes.
  const since = new Date(Date.now() - RATE_WINDOW_MINUTES * 60_000).toISOString();
  const { count } = await supabase
    .from("website_enquiries")
    .select("id", { count: "exact", head: true })
    .eq("ip_hash", ipHash)
    .gte("created_at", since);
  if ((count ?? 0) >= RATE_LIMIT) {
    return json(
      req,
      { error: "Too many submissions. Please try again later.", error_code: "RATE_LIMITED" },
      429,
    );
  }

  const { data: inserted, error: insertError } = await supabase
    .from("website_enquiries")
    .insert({
      idempotency_key: data.idempotencyKey,
      form_type: data.formType,
      name: data.name,
      email: data.email,
      phone: data.phone ?? null,
      license: data.license ?? null,
      experience: data.experience ?? null,
      message: data.message ?? null,
      source: data.source ?? null,
      ip_hash: ipHash,
    })
    .select("id")
    .single();

  if (insertError) {
    // Unique violation = concurrent duplicate submit.
    if ((insertError as { code?: string }).code === "23505") {
      return json(req, { success: true, status: "duplicate" });
    }
    console.error("[website-enquiry] insert failed", insertError);
    return json(req, { error: "Could not record enquiry" }, 500);
  }

  const recipient = Deno.env.get("ONECAB_ENQUIRY_RECIPIENT")?.trim() || "bookings@onecab.net";
  const { subject, html, text } = buildEmail(data);

  const sent = await sendResendEmail({
    to: recipient,
    from: "ONECAB <noreply@onecab.net>",
    subject,
    html,
    text,
    replyTo: data.email,
    allowExternalReplyTo: true,
    tag: data.formType === "driver_application" ? "driver_application" : "website_contact",
  });

  await supabase
    .from("website_enquiries")
    .update({
      email_status: sent.ok ? "sent" : "failed",
      email_error: sent.ok ? null : sent.message,
      provider_message_id: sent.ok ? sent.id ?? null : null,
    })
    .eq("id", inserted.id);

  if (!sent.ok) {
    console.error("[website-enquiry] email send failed", sent.message);
    return json(
      req,
      { error: "Enquiry saved but email delivery failed", error_code: "EMAIL_SEND_FAILED", enquiry_id: inserted.id },
      502,
    );
  }

  return json(req, { success: true, status: "sent", enquiry_id: inserted.id });
});
