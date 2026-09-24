/**
 * Caller gates for public-facing Edge functions.
 * - requireSignedInOrService: verified user session (auth.getUser) or exact service-role key.
 * - requireAdminOrService: exact service-role key, or a verified user holding admin/super_admin in user_roles.
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { bearerToken, requireAuthenticatedUser } from "./edgeAuth.ts";

const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

type GateResult =
  | { ok: true; userId: string | null; isService: boolean }
  | { ok: false; response: Response };

function deny(status: number, code: string, message: string): { ok: false; response: Response } {
  return {
    ok: false,
    response: new Response(JSON.stringify({ success: false, error: code, message }), {
      status,
      headers: JSON_HEADERS,
    }),
  };
}

function isServiceKey(token: string | null): boolean {
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!token || key.length === 0 || token.length !== key.length) return false;
  let mismatch = 0;
  for (let i = 0; i < key.length; i++) mismatch |= token.charCodeAt(i) ^ key.charCodeAt(i);
  return mismatch === 0;
}

export async function requireSignedInOrService(req: Request): Promise<GateResult> {
  const token = bearerToken(req);
  if (isServiceKey(token)) return { ok: true, userId: null, isService: true };
  const auth = await requireAuthenticatedUser(
    req,
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
  );
  if (!auth.ok) return deny(401, "UNAUTHORIZED", "Sign-in required");
  return { ok: true, userId: auth.userId, isService: false };
}

export async function requireAdminOrService(req: Request): Promise<GateResult> {
  const gate = await requireSignedInOrService(req);
  if (!gate.ok || gate.isService) return gate;
  const service = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );
  const { data, error } = await service
    .from("user_roles")
    .select("role")
    .eq("user_id", gate.userId!);
  if (error) return deny(503, "ROLE_CHECK_UNAVAILABLE", "Could not verify permissions");
  const isAdmin = (data ?? []).some((r: { role: string }) => r.role === "admin" || r.role === "super_admin");
  if (!isAdmin) return deny(403, "FORBIDDEN", "Admin role required");
  return gate;
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
