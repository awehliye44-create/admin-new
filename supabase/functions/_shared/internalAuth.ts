// Shared auth helpers for internal/admin gating in edge functions.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { errorResponse } from "./security.ts";

/**
 * Gate that only allows callers presenting the service-role key as Bearer.
 * Use for internal-only functions (cron, function-to-function) that must not
 * be invoked from the public client.
 */
export function assertServiceRole(req: Request): Response | null {
  const auth = req.headers.get("Authorization") || "";
  const expected = `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""}`;
  if (!expected || auth !== expected) {
    return errorResponse("Forbidden: internal endpoint", 403);
  }
  return null;
}

/**
 * Verify the caller's JWT and require they hold the 'admin' or 'super_admin' role
 * via public.user_roles. Returns the user_id or a Response on failure.
 */
export async function requireAdmin(
  req: Request
): Promise<{ userId: string } | Response> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return errorResponse("Missing authorization header", 401);
  }
  const anon = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } }
  );
  const token = authHeader.replace("Bearer ", "");
  const { data, error } = await anon.auth.getClaims(token);
  if (error || !data?.claims) return errorResponse("Invalid token", 401);
  const userId = data.claims.sub as string;

  const service = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  const { data: roles } = await service
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  const isAdmin = (roles || []).some(
    (r: { role: string }) => r.role === "admin" || r.role === "super_admin"
  );
  if (!isAdmin) return errorResponse("Forbidden: admin role required", 403);
  return { userId };
}

/**
 * Verify the caller's JWT and return their auth user id.
 */
export async function requireUser(
  req: Request
): Promise<{ userId: string; token: string } | Response> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return errorResponse("Missing authorization header", 401);
  }
  const anon = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } }
  );
  const token = authHeader.replace("Bearer ", "");
  const { data, error } = await anon.auth.getClaims(token);
  if (error || !data?.claims) return errorResponse("Invalid token", 401);
  return { userId: data.claims.sub as string, token };
}
