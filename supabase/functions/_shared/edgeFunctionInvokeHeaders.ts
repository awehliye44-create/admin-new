/**
 * Headers for one Edge Function calling another.
 *
 * The functions gateway rejects a non-JWT secret in Authorization (HTTP 401)
 * even when verify_jwt is false. The service-role secret is valid for PostgREST
 * via supabase-js, but it must not be forwarded as a function Bearer token.
 * Prefer a caller JWT, then the project anon JWT. Never the service-role secret.
 */
export function edgeFunctionInvokeHeaders(req: Request): Record<string, string> | null {
  let anon = "";
  try {
    anon = Deno.env.get("SUPABASE_ANON_KEY")?.trim() ?? "";
  } catch {
    anon = "";
  }
  const candidates = [
    req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "",
    req.headers.get("apikey")?.trim() ?? "",
    anon,
  ];
  const jwt = candidates.find((value) => value.startsWith("eyJ") && value.split(".").length === 3);
  if (!jwt) return null;
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${jwt}`,
    apikey: jwt,
  };
}
