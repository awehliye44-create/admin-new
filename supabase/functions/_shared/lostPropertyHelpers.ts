import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

export async function authenticateCaller(req: Request): Promise<{ userId: string } | Response> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return errorResp("Unauthorized", 401);

  const client = getUserClient(authHeader);
  const token = authHeader.replace("Bearer ", "");
  const { data, error } = await client.auth.getClaims(token);
  if (error || !data?.claims) return errorResp("Invalid token", 401);
  return { userId: data.claims.sub as string };
}

export async function requireAdmin(req: Request): Promise<{ userId: string } | Response> {
  const auth = await authenticateCaller(req);
  if (auth instanceof Response) return auth;

  const sb = getServiceClient();
  const { data } = await sb.from("profiles").select("role").eq("user_id", auth.userId).single();
  if (!data || data.role !== "admin") return errorResp("Forbidden: admin only", 403);
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
