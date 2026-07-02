// Admin-only vault writer for integration/webhook secrets.
// Raw values are stored in `integration_secret_vault` (default-deny RLS,
// service-role only). The client never receives raw values back — only a
// masked preview it can store alongside its config in `admin_settings`.
import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function mask(value: string): string {
  const v = value.trim();
  if (v.length <= 8) return "••••••••";
  return `${v.slice(0, 4)}••••${v.slice(-4)}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
  const token = authHeader.replace("Bearer ", "");

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
  const svcKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const anon = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userRes, error: userErr } = await anon.auth.getUser(token);
  if (userErr || !userRes?.user) return json({ error: "Unauthorized" }, 401);

  const svc = createClient(supabaseUrl, svcKey);
  const { data: role } = await svc
    .from("user_roles")
    .select("role")
    .eq("user_id", userRes.user.id)
    .eq("role", "admin")
    .maybeSingle();
  if (!role) return json({ error: "Forbidden — admin required" }, 403);

  let body: {
    namespace?: string;
    owner_id?: string;
    action?: "set" | "delete_owner";
    secrets?: Record<string, string>;
  };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const namespace = String(body.namespace ?? "");
  const ownerId = String(body.owner_id ?? "");
  if (!namespace || !ownerId) return json({ error: "namespace + owner_id required" }, 400);
  if (!["integration", "webhook"].includes(namespace)) {
    return json({ error: "Invalid namespace" }, 400);
  }

  if (body.action === "delete_owner") {
    const { error } = await svc
      .from("integration_secret_vault")
      .delete()
      .eq("namespace", namespace)
      .eq("owner_id", ownerId);
    if (error) return json({ error: error.message }, 500);
    return json({ success: true });
  }

  const secrets = body.secrets ?? {};
  const previews: Record<string, string> = {};
  for (const [name, raw] of Object.entries(secrets)) {
    if (typeof raw !== "string" || !raw.length) continue;
    const masked = mask(raw);
    const { error } = await svc.from("integration_secret_vault").upsert(
      {
        namespace,
        owner_id: ownerId,
        secret_name: name,
        secret_value: raw,
        masked_preview: masked,
        updated_by: userRes.user.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "namespace,owner_id,secret_name" },
    );
    if (error) return json({ error: error.message }, 500);
    previews[name] = masked;
  }

  return json({ success: true, previews });
});
