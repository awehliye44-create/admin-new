/**
 * Admission control for send-driver-notification.
 *
 * Accepts exactly one of:
 *   A) Authorization: Bearer <exact SUPABASE_SERVICE_ROLE_KEY>
 *   B) X-ONECAB-INTERNAL-NOTIFICATION-TOKEN: <exact ONECAB_INTERNAL_NOTIFICATION_TOKEN>
 *
 * Never accepts anon/publishable keys, user JWTs, decoded-role-only checks,
 * or substring/includes matching.
 *
 * Each path fails closed independently when its own configured secret is missing.
 * A credential presented on one path never authenticates against the other secret.
 */

export const INTERNAL_NOTIFICATION_TOKEN_HEADER =
  "x-onecab-internal-notification-token";

export type InternalNotificationAuthOk = {
  ok: true;
  source: "service_role_bearer" | "internal_notification_token";
};

export type InternalNotificationAuthDenied = {
  ok: false;
  response: Response;
};

export type InternalNotificationAuthResult =
  | InternalNotificationAuthOk
  | InternalNotificationAuthDenied;

const UNAUTHORIZED_BODY = JSON.stringify({
  error: "UNAUTHORIZED",
  message: "Unauthorized",
});

function unauthorizedResponse(): Response {
  return new Response(UNAUTHORIZED_BODY, {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

/** Constant-time string compare (length mismatch short-circuits safely). */
export function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Exact Bearer parse: scheme "Bearer" + single SP + token.
 * Rejects missing/empty token, tabs, multiple spaces, or non-Bearer schemes.
 */
export function parseExactBearerToken(authorizationHeader: string | null): string | null {
  if (authorizationHeader == null) return null;
  if (!authorizationHeader.startsWith("Bearer ")) return null;
  const token = authorizationHeader.slice("Bearer ".length);
  if (!token || token !== token.trim() || /\s/.test(token)) return null;
  return token;
}

function getSingleHeaderValue(req: Request, name: string): string | null | "ambiguous" {
  // Headers.get joins duplicates with ", " — treat any comma-joined multi as ambiguous.
  const raw = req.headers.get(name);
  if (raw == null) return null;
  if (raw.includes(",")) return "ambiguous";
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed;
}

export type InternalNotificationAuthEnv = {
  serviceRoleKey: string;
  internalNotificationToken: string;
  anonKey?: string;
};

/**
 * Authenticate a non-OPTIONS request for send-driver-notification.
 * Does not read or parse the body. Does not log header or secret values.
 */
export function authorizeInternalNotificationRequest(
  req: Request,
  env: InternalNotificationAuthEnv = {
    serviceRoleKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    internalNotificationToken: Deno.env.get("ONECAB_INTERNAL_NOTIFICATION_TOKEN") ?? "",
    anonKey: Deno.env.get("SUPABASE_ANON_KEY") ?? "",
  },
): InternalNotificationAuthResult {
  const serviceRoleKey = env.serviceRoleKey;
  const internalToken = env.internalNotificationToken;
  const anonKey = env.anonKey ?? "";

  const authHeader = req.headers.get("Authorization");
  // Multiple Authorization headers are joined by Fetch with ", ".
  if (authHeader != null && authHeader.includes(",")) {
    return { ok: false, response: unauthorizedResponse() };
  }

  const bearer = parseExactBearerToken(authHeader);
  const internalHeader = getSingleHeaderValue(req, INTERNAL_NOTIFICATION_TOKEN_HEADER);
  if (internalHeader === "ambiguous") {
    return { ok: false, response: unauthorizedResponse() };
  }

  const hasBearer = bearer != null;
  const hasInternal = internalHeader != null;

  // Exactly one credential channel.
  if (hasBearer && hasInternal) {
    return { ok: false, response: unauthorizedResponse() };
  }

  if (hasBearer) {
    // Missing service-role env → Bearer path fails closed (does not try internal secret).
    if (!serviceRoleKey) {
      return { ok: false, response: unauthorizedResponse() };
    }
    if (anonKey && timingSafeEqualString(bearer!, anonKey)) {
      return { ok: false, response: unauthorizedResponse() };
    }
    // Internal token must never authenticate via Authorization Bearer.
    if (internalToken && timingSafeEqualString(bearer!, internalToken)) {
      return { ok: false, response: unauthorizedResponse() };
    }
    if (timingSafeEqualString(bearer!, serviceRoleKey)) {
      return { ok: true, source: "service_role_bearer" };
    }
    return { ok: false, response: unauthorizedResponse() };
  }

  if (hasInternal) {
    // Missing internal env → header path fails closed (does not try service-role secret).
    if (!internalToken) {
      return { ok: false, response: unauthorizedResponse() };
    }
    // Service-role key must never authenticate via the internal header.
    if (serviceRoleKey && timingSafeEqualString(internalHeader!, serviceRoleKey)) {
      return { ok: false, response: unauthorizedResponse() };
    }
    if (timingSafeEqualString(internalHeader!, internalToken)) {
      return { ok: true, source: "internal_notification_token" };
    }
    return { ok: false, response: unauthorizedResponse() };
  }

  return { ok: false, response: unauthorizedResponse() };
}

export function methodNotAllowedResponse(): Response {
  return new Response(
    JSON.stringify({ error: "METHOD_NOT_ALLOWED", message: "Method not allowed" }),
    {
      status: 405,
      headers: {
        "Content-Type": "application/json",
        Allow: "POST, OPTIONS",
        "Cache-Control": "no-store",
      },
    },
  );
}
