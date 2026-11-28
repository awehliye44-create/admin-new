/**
 * #57F/G — Session-scoped access role helpers (not user-wide app_metadata).
 */

export type OnecabAccessRole = "customer" | "driver";

export function normalizeOnecabAccessRole(raw: unknown): OnecabAccessRole | null {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (v === "customer" || v === "rider" || v === "passenger") return "customer";
  if (v === "driver") return "driver";
  return null;
}

/** Extract Auth session id from verified JWT claims (GoTrue). */
export function resolveAuthSessionIdFromClaims(claims: Record<string, unknown> | null | undefined): string | null {
  if (!claims || typeof claims !== "object") return null;
  const raw = claims.session_id ?? claims.sessionId ?? null;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // UUID shape — reject forged garbage early.
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(trimmed)
  ) {
    return null;
  }
  return trimmed;
}

/**
 * RLS predicate semantics (mirror of SQL): unbound → deny role-gated access.
 * Simultaneous Customer/Driver sessions are independent by session_id.
 */
export function sessionRoleAllowsAccess(args: {
  boundRole: string | null | undefined;
  requiredRole: OnecabAccessRole;
}): boolean {
  return args.boundRole === args.requiredRole;
}
