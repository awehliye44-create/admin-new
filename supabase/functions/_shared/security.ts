/**
 * Shared security utilities for Edge Functions.
 * Dual-compatible with:
 * - stop-workflow / auto-dispatch style: errorResponse(code, message, status, details?)
 * - newer payment edges: errorResponse(message, status, details?, errorCode?)
 */

// ==================== SECURITY HEADERS ====================

export const ONECAB_NATIVE_CLIENT_HEADER = "x-onecab-native-client";

const BASE_CORS_ALLOW_HEADERS =
  "authorization, x-client-info, apikey, content-type";

export const SUPABASE_CLIENT_CORS_ALLOW_HEADERS =
  `${BASE_CORS_ALLOW_HEADERS}, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version`;

/** Native Capacitor direct fetch sends this header on auth/eligibility preflights. */
export const NATIVE_APP_CORS_ALLOW_HEADERS =
  `${SUPABASE_CLIENT_CORS_ALLOW_HEADERS}, ${ONECAB_NATIVE_CLIENT_HEADER}`;

export const nativeAppCorsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": NATIVE_APP_CORS_ALLOW_HEADERS,
};

export const securityHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": NATIVE_APP_CORS_ALLOW_HEADERS,
  "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "X-XSS-Protection": "1; mode=block",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "geolocation=(), microphone=(), camera=()",
};

// CORS headers for preflight requests (without Content-Type)
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": NATIVE_APP_CORS_ALLOW_HEADERS,
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
};

export const jsonHeaders = {
  ...securityHeaders,
  "Content-Type": "application/json",
};

// ==================== RATE LIMITING ====================

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();

const cleanupInterval = 60000;
let lastCleanup = Date.now();

function cleanupExpiredEntries() {
  const now = Date.now();
  if (now - lastCleanup < cleanupInterval) return;
  lastCleanup = now;
  for (const [key, entry] of rateLimitStore.entries()) {
    if (entry.resetAt < now) rateLimitStore.delete(key);
  }
}

export interface RateLimitConfig {
  limit: number;
  windowMs: number;
  keyPrefix?: string;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfter?: number;
}

export function checkRateLimit(
  identifier: string,
  config: RateLimitConfig = { limit: 100, windowMs: 60000 },
): RateLimitResult {
  cleanupExpiredEntries();

  const { limit, windowMs, keyPrefix = "" } = config;
  const key = `${keyPrefix}:${identifier}`;
  const now = Date.now();

  let entry = rateLimitStore.get(key);
  if (!entry || entry.resetAt < now) {
    entry = { count: 0, resetAt: now + windowMs };
  }

  entry.count++;
  rateLimitStore.set(key, entry);

  const remaining = Math.max(0, limit - entry.count);
  const allowed = entry.count <= limit;

  return {
    allowed,
    remaining,
    resetAt: entry.resetAt,
    retryAfter: allowed ? undefined : Math.ceil((entry.resetAt - now) / 1000),
  };
}

export function getClientIP(req: Request): string {
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0].trim();
  return (
    req.headers.get("x-real-ip") ||
    req.headers.get("cf-connecting-ip") ||
    "unknown"
  );
}

/** Accept RateLimitResult (stop-workflow) or retryAfter number (legacy callers). */
export function rateLimitResponse(resultOrRetryAfter: RateLimitResult | number): Response {
  const result: RateLimitResult = typeof resultOrRetryAfter === "number"
    ? {
      allowed: false,
      remaining: 0,
      resetAt: Date.now() + resultOrRetryAfter * 1000,
      retryAfter: resultOrRetryAfter,
    }
    : resultOrRetryAfter;

  return new Response(
    JSON.stringify({
      error: "RATE_LIMIT_EXCEEDED",
      message: "Too many requests. Please try again later.",
      retryAfter: result.retryAfter,
      success: false,
    }),
    {
      status: 429,
      headers: {
        ...jsonHeaders,
        "Retry-After": String(result.retryAfter || 60),
        "X-RateLimit-Remaining": String(result.remaining),
        "X-RateLimit-Reset": String(Math.ceil(result.resetAt / 1000)),
      },
    },
  );
}

// ==================== INPUT VALIDATION ====================

export function isValidUUID(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(value);
}

export function sanitizeString(value: unknown, maxLength = 1000): string {
  if (typeof value !== "string") return "";
  // eslint-disable-next-line no-control-regex -- intentional strip of disallowed ASCII controls
  let sanitized = value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  sanitized = sanitized.trim().slice(0, maxLength);
  return sanitized;
}

export function isValidAction(action: unknown, validActions: string[]): action is string {
  if (typeof action !== "string") return false;
  return validActions.includes(action);
}

export function isValidLatitude(lat: number): boolean {
  return typeof lat === "number" && !isNaN(lat) && lat >= -90 && lat <= 90;
}

export function isValidLongitude(lng: number): boolean {
  return typeof lng === "number" && !isNaN(lng) && lng >= -180 && lng <= 180;
}

export function isPositiveInteger(num: number): boolean {
  return typeof num === "number" && Number.isInteger(num) && num > 0;
}

export function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && !isNaN(value) && value > 0;
}

export function isValidCoordinate(lat: unknown, lng: unknown): boolean {
  if (typeof lat !== "number" || typeof lng !== "number") return false;
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

export function isValidPaymentMethod(method: string): boolean {
  const validMethods = [
    "CARD",
    "WALLET",
    "APPLE_PAY",
    "GOOGLE_PAY",
    "REVOLUT",
    "CORPORATE_ACCOUNT",
  ];
  return validMethods.includes(method);
}

// ==================== RESPONSES ====================

export function validationErrorResponse(
  errors: string[] | Record<string, string>,
): Response {
  const body = Array.isArray(errors)
    ? {
      success: false,
      error: "Validation failed",
      error_code: "VALIDATION_FAILED",
      validation_errors: errors,
      retry_allowed: false,
    }
    : {
      error: "VALIDATION_ERROR",
      message: "Invalid request data",
      details: errors,
    };
  return new Response(JSON.stringify(body), {
    status: 400,
    headers: jsonHeaders,
  });
}

export function handleCORSPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: securityHeaders,
  });
}

export function successResponse(data: unknown, status = 200): Response {
  const body = data && typeof data === "object" && !Array.isArray(data)
    ? { success: true, ...(data as Record<string, unknown>) }
    : data;
  return new Response(JSON.stringify(body), {
    status,
    headers: jsonHeaders,
  });
}

/**
 * Dual signature:
 * - Old (stop-workflow): errorResponse(code, message, status?, details?)
 * - New (payment edges): errorResponse(message, status?, details?, errorCode?)
 */
export function errorResponse(
  errorOrMessage: string,
  messageOrStatus: string | number = 400,
  statusOrDetails: number | Record<string, unknown> | unknown = 500,
  detailsOrErrorCode?: unknown,
): Response {
  // New style: second arg is numeric status
  if (typeof messageOrStatus === "number") {
    const status = messageOrStatus;
    const details = typeof statusOrDetails === "object" && statusOrDetails !== null
      ? statusOrDetails as Record<string, unknown>
      : undefined;
    const errorCode = typeof detailsOrErrorCode === "string" ? detailsOrErrorCode : null;
    return new Response(
      JSON.stringify({
        success: false,
        error: errorOrMessage,
        error_code: errorCode,
        retry_allowed: status >= 500,
        ...(details ?? {}),
      }),
      { status, headers: jsonHeaders },
    );
  }

  // Old style: (code, message, status?, details?)
  const status = typeof statusOrDetails === "number" ? statusOrDetails : 500;
  const details = detailsOrErrorCode;
  const body: Record<string, unknown> = {
    error: errorOrMessage,
    message: messageOrStatus,
  };
  if (details !== undefined) body.details = details;
  return new Response(JSON.stringify(body), {
    status,
    headers: jsonHeaders,
  });
}

export async function logAuditEvent(
  supabase: any,
  eventType: string,
  options: {
    userId?: string;
    driverId?: string;
    tripId?: string;
    details?: Record<string, unknown>;
    ipAddress?: string;
    userAgent?: string;
  } = {},
): Promise<void> {
  try {
    await supabase.rpc("log_audit_event", {
      p_event_type: eventType,
      p_user_id: options.userId || null,
      p_driver_id: options.driverId || null,
      p_trip_id: options.tripId || null,
      p_details: options.details || {},
      p_ip_address: options.ipAddress || null,
      p_user_agent: options.userAgent || null,
    });
  } catch (error) {
    console.error("[audit] Failed to log audit event:", eventType, error);
  }
}
