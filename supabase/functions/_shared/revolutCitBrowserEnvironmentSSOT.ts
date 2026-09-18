/**
 * Revolut CIT (customer-initiated) browser environment SSOT.
 *
 * Book / create-preauth saved-card Pay-for-order ALWAYS uses initiator=`customer`.
 * For initiator=customer, Revolut Merchant API 2024-09-01 requires `environment`
 * with type=browser and required fields:
 *   time_zone_utc_offset, color_depth, screen_width, screen_height, java_enabled
 * Optional: challenge_window_width, browser_url.
 *
 * NEVER invent defaults for required fields. Clients must send real device
 * context; missing/invalid → fail closed before Pay (prefer before order create).
 */

export type RevolutCitBrowserEnvironment = {
  type: "browser";
  /** Minutes east of UTC (Revolut). Europe/London BST = 60. */
  time_zone_utc_offset: number;
  color_depth: number;
  screen_width: number;
  screen_height: number;
  java_enabled: boolean;
  challenge_window_width?: number;
  browser_url?: string;
};

export type ParseCitBrowserEnvironmentResult =
  | { ok: true; environment: RevolutCitBrowserEnvironment }
  | { ok: false; code: "BROWSER_ENVIRONMENT_REQUIRED" | "BROWSER_ENVIRONMENT_INVALID"; message: string };

const ERR_REQUIRED =
  "Device browser context is required for bank verification. Please update the app and try again.";
const ERR_INVALID =
  "Device browser context is invalid. Please try again from your phone.";

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isPositiveInt(v: unknown): v is number {
  return isFiniteNumber(v) && Number.isInteger(v) && v > 0;
}

/**
 * Accept https://… or a custom app deep-link scheme (e.g. onecab-customer://…).
 * Reject empty, http (non-TLS), and non-app protocols (ftp, etc.).
 */
export function isAllowedCitBrowserUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  if (/^https:\/\//i.test(trimmed)) return true;
  // App deep link: alphanumeric scheme (not a known non-app protocol)
  const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed);
  if (!m) return false;
  const scheme = m[1]!.toLowerCase();
  if (scheme === "http" || scheme === "ftp" || scheme === "file" || scheme === "javascript") {
    return false;
  }
  // Require a non-empty scheme body after ://
  return trimmed.length > scheme.length + 3;
}

/**
 * Fail-closed parse of client `browser_environment` (or nested body field).
 * Does not invent defaults for required Revolut fields.
 */
export function parseAndValidateCitBrowserEnvironment(
  raw: unknown,
): ParseCitBrowserEnvironmentResult {
  if (raw == null) {
    return { ok: false, code: "BROWSER_ENVIRONMENT_REQUIRED", message: ERR_REQUIRED };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, code: "BROWSER_ENVIRONMENT_INVALID", message: ERR_INVALID };
  }
  const o = raw as Record<string, unknown>;

  if (o.type !== "browser") {
    return { ok: false, code: "BROWSER_ENVIRONMENT_INVALID", message: ERR_INVALID };
  }
  if (!isFiniteNumber(o.time_zone_utc_offset) || !Number.isInteger(o.time_zone_utc_offset)) {
    return { ok: false, code: "BROWSER_ENVIRONMENT_INVALID", message: ERR_INVALID };
  }
  // Revolut offset is minutes east of UTC; allow common range ±14h.
  if (o.time_zone_utc_offset < -840 || o.time_zone_utc_offset > 840) {
    return { ok: false, code: "BROWSER_ENVIRONMENT_INVALID", message: ERR_INVALID };
  }
  if (!isPositiveInt(o.color_depth) || o.color_depth > 48) {
    return { ok: false, code: "BROWSER_ENVIRONMENT_INVALID", message: ERR_INVALID };
  }
  if (!isPositiveInt(o.screen_width) || o.screen_width > 10000) {
    return { ok: false, code: "BROWSER_ENVIRONMENT_INVALID", message: ERR_INVALID };
  }
  if (!isPositiveInt(o.screen_height) || o.screen_height > 10000) {
    return { ok: false, code: "BROWSER_ENVIRONMENT_INVALID", message: ERR_INVALID };
  }
  if (typeof o.java_enabled !== "boolean") {
    return { ok: false, code: "BROWSER_ENVIRONMENT_INVALID", message: ERR_INVALID };
  }

  const env: RevolutCitBrowserEnvironment = {
    type: "browser",
    time_zone_utc_offset: o.time_zone_utc_offset,
    color_depth: o.color_depth,
    screen_width: o.screen_width,
    screen_height: o.screen_height,
    java_enabled: o.java_enabled,
  };

  if (o.challenge_window_width !== undefined) {
    if (!isPositiveInt(o.challenge_window_width) || o.challenge_window_width > 10000) {
      return { ok: false, code: "BROWSER_ENVIRONMENT_INVALID", message: ERR_INVALID };
    }
    env.challenge_window_width = o.challenge_window_width;
  }

  if (o.browser_url !== undefined) {
    if (typeof o.browser_url !== "string" || !isAllowedCitBrowserUrl(o.browser_url)) {
      return { ok: false, code: "BROWSER_ENVIRONMENT_INVALID", message: ERR_INVALID };
    }
    env.browser_url = o.browser_url.trim();
  }

  return { ok: true, environment: env };
}

/** Extract browser_environment from create-preauth body (top-level or nested). */
export function extractBrowserEnvironmentFromPreauthBody(
  body: Record<string, unknown> | null | undefined,
): unknown {
  if (!body || typeof body !== "object") return null;
  if ("browser_environment" in body) return body.browser_environment;
  const nested = body.environment;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const n = nested as Record<string, unknown>;
    if (n.type === "browser") return nested;
  }
  return null;
}

export function citBrowserEnvironmentErrorResponse(
  parsed: Extract<ParseCitBrowserEnvironmentResult, { ok: false }>,
  corsHeaders: Record<string, string>,
): Response {
  return new Response(JSON.stringify({
    error: parsed.message,
    code: parsed.code,
    error_code: parsed.code,
    charge_state: "no_charge",
  }), {
    headers: { ...corsHeaders, "Content-Type": "application/json" },
    status: 422,
  });
}
