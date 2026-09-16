import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { assertCronOrServiceRoleAuth, extractBearerToken } from "./cronEdgeAuth.ts";

export type DemandZoneRecomputeAuth =
  | { ok: true; mode: "internal" | "staff"; userId?: string }
  | { ok: false; response: Response };

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
};

/** Cron/service-role OR staff with demand_zones.recompute. Rejects anon JWT. */
export async function requireDemandZoneRecomputeAuth(
  req: Request,
  body?: Record<string, unknown>,
): Promise<DemandZoneRecomputeAuth> {
  const internal = await assertCronOrServiceRoleAuth(req, body);
  if (internal.ok) {
    return { ok: true, mode: "internal" };
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !serviceKey || !anonKey) {
    return { ok: false, response: internal.response };
  }

  const token = extractBearerToken(req);
  if (!token) {
    return { ok: false, response: internal.response };
  }

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error } = await userClient.auth.getUser();
  if (error || !user) {
    return { ok: false, response: internal.response };
  }

  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: allowed, error: rpcErr } = await admin.rpc("staff_has_action", {
    _user_id: user.id,
    _action_key: "demand_zones.recompute",
  });
  if (rpcErr || !allowed) {
    return {
      ok: false,
      response: new Response(
        JSON.stringify({ error: "Forbidden — demand_zones.recompute required" }),
        { status: 403, headers: JSON_HEADERS },
      ),
    };
  }

  return { ok: true, mode: "staff", userId: user.id };
}
