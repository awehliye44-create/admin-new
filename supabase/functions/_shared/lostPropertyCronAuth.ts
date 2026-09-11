/**
 * Phase A8B27B — admission control for lost-property cron actions only.
 *
 * Accepts exactly one credential:
 *   X-ONECAB-INTERNAL-LOST-PROPERTY-CRON-TOKEN: <ONECAB_INTERNAL_LOST_PROPERTY_CRON_TOKEN>
 *
 * Rejects:
 *   - missing/incorrect/ambiguous internal header
 *   - any Authorization / Bearer channel (including dual credentials)
 *   - missing/short Edge env secret
 *
 * Does not read the body. Does not log header or secret values.
 * Does not authorize Admin/Driver/Customer actions.
 *
 * Rollback target (exact pre-gate Stage 1 production):
 *   lost-property ACTIVE v268
 *   ezbr_sha256: 9915b231bf422f44b9de78dbb2d0c5026ab8e1a0fd9951cac1b34fe5204d70c0
 *   helpers sha256: 94cdc04cf2ddc6a00fd0d7aeccf10dbd2ab6bb377e1b53229dae221a9a18427e
 *   entrypoint sha256: 27b084f4b4c5f4cf85897c9b2955a2acd51a0188c8fb2bea9905fbd17261c2aa
 */

export const LOST_PROPERTY_CRON_ACTIONS = [
  "cleanup_photos",
  "expire_chats",
] as const;

export type LostPropertyCronAction = (typeof LOST_PROPERTY_CRON_ACTIONS)[number];

export const INTERNAL_LOST_PROPERTY_CRON_TOKEN_HEADER =
  "x-onecab-internal-lost-property-cron-token";

export const INTERNAL_LOST_PROPERTY_CRON_TOKEN_HEADER_CANONICAL =
  "X-ONECAB-INTERNAL-LOST-PROPERTY-CRON-TOKEN";

export type LostPropertyCronAuthOk = { ok: true };
export type LostPropertyCronAuthDenied = { ok: false; response: Response };
export type LostPropertyCronAuthResult =
  | LostPropertyCronAuthOk
  | LostPropertyCronAuthDenied;

export type LostPropertyCronAuthEnv = {
  internalLostPropertyCronToken: string;
};

const UNAUTHORIZED_BODY = JSON.stringify({
  success: false,
  error: "Unauthorized",
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

export function methodNotAllowedCronResponse(): Response {
  return new Response(
    JSON.stringify({ success: false, error: "Method not allowed" }),
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

/** Constant-time string compare (length mismatch short-circuits safely). */
export function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

export function isLostPropertyCronAction(
  action: string | null,
): action is LostPropertyCronAction {
  return action === "cleanup_photos" || action === "expire_chats";
}

function getSingleHeaderValue(req: Request, name: string): string | null | "ambiguous" {
  const raw = req.headers.get(name);
  if (raw == null) return null;
  if (raw.includes(",")) return "ambiguous";
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed;
}

/**
 * Authenticate a non-OPTIONS request for cleanup_photos / expire_chats.
 * Call before creating a service client or performing side effects.
 */
export function authorizeLostPropertyCronRequest(
  req: Request,
  env: LostPropertyCronAuthEnv = {
    internalLostPropertyCronToken:
      Deno.env.get("ONECAB_INTERNAL_LOST_PROPERTY_CRON_TOKEN") ?? "",
  },
): LostPropertyCronAuthResult {
  if (req.method !== "POST") {
    return { ok: false, response: methodNotAllowedCronResponse() };
  }

  const configured = env.internalLostPropertyCronToken;
  if (!configured || configured.length < 32) {
    return { ok: false, response: unauthorizedResponse() };
  }

  // Any Authorization channel is forbidden for cron actions (no dual path).
  const authHeader = req.headers.get("Authorization");
  if (authHeader != null && authHeader.trim() !== "") {
    return { ok: false, response: unauthorizedResponse() };
  }

  const internalHeader = getSingleHeaderValue(
    req,
    INTERNAL_LOST_PROPERTY_CRON_TOKEN_HEADER,
  );
  if (internalHeader === "ambiguous" || internalHeader == null) {
    return { ok: false, response: unauthorizedResponse() };
  }

  if (!timingSafeEqualString(internalHeader, configured)) {
    return { ok: false, response: unauthorizedResponse() };
  }

  return { ok: true };
}
