import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Phase A8B27 — lost-property Admin gate (draft; not deployed until approved).
 *
 * Rollback identifiers for pre-change production:
 *   Edge slug: lost-property
 *   version: 266
 *   status: ACTIVE
 *   verify_jwt: false
 *   ezbr_sha256: 2b9d3652fb9dcd240eaf68cb7eb23edb5839d7ef8f7e67cc95e0ade23c58d730
 *   helpers sha256: ebabc9989694dc758f8e7283fe09d5b321b55f556c1adf6962b3738f8aff2eb9
 *   entrypoint sha256: 27b084f4b4c5f4cf85897c9b2955a2acd51a0188c8fb2bea9905fbd17261c2aa
 *
 * Remediation (Option B): after Bearer JWT subject is verified, evaluate
 * staff_has_page_access('lost-property') semantics with the verified user id
 * via service-role table reads. Do not call auth.uid()-bound RPC under
 * service_role (auth.uid() would be null). Do not use profiles.role.
 */

export const LOST_PROPERTY_PAGE_SLUG = "lost-property";

export function getServiceClient() {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
}

export function getUserClient(authHeader: string) {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authHeader } } }
  );
}

export const LP_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

export function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...LP_CORS, "Content-Type": "application/json" },
  });
}

export function errorResp(msg: string, status = 400) {
  return jsonResponse({ success: false, error: msg }, status);
}

/** Pure evaluator mirroring public.staff_has_page_access(p_page_slug) semantics. */
export function evaluateStaffHasPageAccess(args: {
  pageSlug: string;
  staff:
    | { role: string; is_active: boolean }
    | null
    | undefined;
  pagePermission:
    | { can_access: boolean }
    | null
    | undefined;
}): boolean {
  if (!args.pageSlug) return false;
  if (!args.staff || args.staff.is_active !== true) return false;
  if (!args.staff.role) return false;
  return args.pagePermission?.can_access === true;
}

/** Minimal query surface; accepts Supabase client or test fakes. */
// deno-lint-ignore no-explicit-any
type StaffPageAccessClient = { from: (table: string) => any };

/**
 * Service-role reads bound to verifiedUserId (NOT auth.uid()).
 * Matches staff_has_page_access(pageSlug) for that subject.
 */
export async function staffHasPageAccessForUser(
  sb: StaffPageAccessClient,
  verifiedUserId: string,
  pageSlug: string = LOST_PROPERTY_PAGE_SLUG,
): Promise<boolean> {
  if (!verifiedUserId || !pageSlug) return false;

  const { data: staffRow, error: staffErr } = await sb
    .from("staff_profiles")
    .select("role, is_active")
    .eq("user_id", verifiedUserId)
    .eq("is_active", true)
    .maybeSingle();
  if (staffErr) return false;

  const staff = staffRow as { role: string; is_active: boolean } | null;
  if (!staff?.role) {
    return evaluateStaffHasPageAccess({ pageSlug, staff: null, pagePermission: null });
  }

  const { data: permRow, error: permErr } = await sb
    .from("role_page_permissions")
    .select("can_access")
    .eq("role", staff.role)
    .eq("page_slug", pageSlug)
    .maybeSingle();
  if (permErr) return false;

  const perm = permRow as { can_access: boolean } | null;
  return evaluateStaffHasPageAccess({
    pageSlug,
    staff,
    pagePermission: perm,
  });
}

export async function authenticateCaller(req: Request): Promise<{ userId: string } | Response> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return errorResp("Unauthorized", 401);

  const client = getUserClient(authHeader);
  const token = authHeader.replace("Bearer ", "");
  const { data, error } = await client.auth.getClaims(token);
  if (error || !data?.claims) return errorResp("Invalid token", 401);
  const userId = data.claims.sub as string;
  if (!userId) return errorResp("Invalid token", 401);
  return { userId };
}

/**
 * Admin/staff gate for lost-property Admin actions only.
 * JWT subject verified first; page access evaluated with that subject id.
 */
export async function requireAdmin(req: Request): Promise<{ userId: string } | Response> {
  const auth = await authenticateCaller(req);
  if (auth instanceof Response) return auth;

  const sb = getServiceClient();
  const allowed = await staffHasPageAccessForUser(sb, auth.userId, LOST_PROPERTY_PAGE_SLUG);
  if (!allowed) return errorResp("Forbidden: admin only", 403);
  return auth;
}

export async function getCustomerId(userId: string): Promise<string | null> {
  const sb = getServiceClient();
  const { data } = await sb.from("customers").select("id").eq("user_id", userId).single();
  return data?.id || null;
}

export async function getDriverId(userId: string): Promise<string | null> {
  const sb = getServiceClient();
  const { data } = await sb.from("drivers").select("id").eq("user_id", userId).order("created_at").limit(1).single();
  return data?.id || null;
}

export async function insertSystemMessage(caseId: string, message: string) {
  const sb = getServiceClient();
  await sb.from("lost_property_messages").insert({
    case_id: caseId,
    sender_type: "SYSTEM",
    message,
  });
}

export async function verifyChatOpen(caseId: string): Promise<string | null> {
  const sb = getServiceClient();
  const { data } = await sb
    .from("lost_property_cases")
    .select("chat_enabled, chat_expires_at, status")
    .eq("id", caseId)
    .single();
  if (!data) return "Case not found";
  if (data.status === "CLOSED" || data.status === "closed") return "Case is closed";
  if (!data.chat_enabled) return "Chat is locked";
  if (new Date(data.chat_expires_at) < new Date()) return "Chat has expired";
  return null;
}
