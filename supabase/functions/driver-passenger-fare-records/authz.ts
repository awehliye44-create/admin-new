/** Reject missing/blank/anon/service-role bearer tokens before getUser(). */
export function extractDriverBearerToken(
  authHeader: string | null,
  anonKey: string | undefined,
  serviceKey: string | undefined,
): { ok: true; token: string } | { ok: false; error: string } {
  if (!authHeader || !authHeader.trim()) {
    return { ok: false, error: "Missing authorization" };
  }
  const match = authHeader.trim().match(/^Bearer\s+(.+)$/i);
  if (!match?.[1]) {
    return { ok: false, error: "Invalid authorization" };
  }
  const token = match[1].trim();
  if (!token) {
    return { ok: false, error: "Invalid authorization" };
  }
  if (anonKey && token === anonKey) {
    return { ok: false, error: "Unauthorized" };
  }
  if (serviceKey && token === serviceKey) {
    return { ok: false, error: "Unauthorized" };
  }
  if (token.startsWith("sb_secret_") || /service_role/i.test(token)) {
    return { ok: false, error: "Unauthorized" };
  }
  return { ok: true, token };
}
