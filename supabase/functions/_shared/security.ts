/**
 * Shared security utilities for Edge Functions
 * Rate limiting, security headers, and input validation
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
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': NATIVE_APP_CORS_ALLOW_HEADERS,
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'X-XSS-Protection': '1; mode=block',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
};

export const jsonHeaders = {
  ...securityHeaders,
  'Content-Type': 'application/json',
};

// ==================== RATE LIMITING ====================

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// In-memory rate limit store (per Edge Function instance)
const rateLimitStore = new Map<string, RateLimitEntry>();

// Clean up expired entries periodically
const cleanupInterval = 60000; // 1 minute
let lastCleanup = Date.now();

function cleanupExpiredEntries() {
  const now = Date.now();
  if (now - lastCleanup < cleanupInterval) return;
  
  lastCleanup = now;
  for (const [key, entry] of rateLimitStore.entries()) {
    if (entry.resetAt < now) {
      rateLimitStore.delete(key);
    }
  }
}

export interface RateLimitConfig {
  /** Maximum requests allowed in the window */
  limit: number;
  /** Window size in milliseconds */
  windowMs: number;
  /** Key prefix for different endpoints */
  keyPrefix?: string;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfter?: number;
}

/**
 * Check if a request should be rate limited
 */
export function checkRateLimit(
  identifier: string,
  config: RateLimitConfig = { limit: 100, windowMs: 60000 }
): RateLimitResult {
  cleanupExpiredEntries();
  
  const { limit, windowMs, keyPrefix = '' } = config;
  const key = `${keyPrefix}:${identifier}`;
  const now = Date.now();
  
  let entry = rateLimitStore.get(key);
  
  // Create new entry or reset expired entry
  if (!entry || entry.resetAt < now) {
    entry = {
      count: 0,
      resetAt: now + windowMs,
    };
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

/**
 * Get client IP from request headers
 */
export function getClientIP(req: Request): string {
  // Check various headers for the real IP
  const forwardedFor = req.headers.get('x-forwarded-for');
  if (forwardedFor) {
    // x-forwarded-for can contain multiple IPs; take the first (original client)
    return forwardedFor.split(',')[0].trim();
  }
  
  const realIP = req.headers.get('x-real-ip');
  if (realIP) {
    return realIP;
  }
  
  const cfConnectingIP = req.headers.get('cf-connecting-ip');
  if (cfConnectingIP) {
    return cfConnectingIP;
  }
  
  // Fallback to a default identifier
  return 'unknown';
}

/**
 * Create rate limit response
 */
export function rateLimitResponse(result: RateLimitResult): Response {
  return new Response(
    JSON.stringify({
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests. Please try again later.',
      retryAfter: result.retryAfter,
    }),
    {
      status: 429,
      headers: {
        ...jsonHeaders,
        'Retry-After': String(result.retryAfter || 60),
        'X-RateLimit-Limit': '100',
        'X-RateLimit-Remaining': String(result.remaining),
        'X-RateLimit-Reset': String(Math.ceil(result.resetAt / 1000)),
      },
    }
  );
}

// ==================== INPUT VALIDATION ====================

/**
 * Validate UUID format
 */
export function isValidUUID(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(value);
}

/**
 * Validate and sanitize string input
 */
export function sanitizeString(value: unknown, maxLength = 1000): string | null {
  if (typeof value !== 'string') return null;
  
  // Remove null bytes and control characters (except newlines and tabs)
  // eslint-disable-next-line no-control-regex -- intentional strip of disallowed ASCII controls
  let sanitized = value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  
  // Trim and limit length
  sanitized = sanitized.trim().slice(0, maxLength);
  
  return sanitized || null;
}

/**
 * Validate action type is in allowed list
 */
export function isValidAction(action: unknown, validActions: string[]): action is string {
  if (typeof action !== 'string') return false;
  return validActions.includes(action);
}

/**
 * Validate positive number
 */
export function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && !isNaN(value) && value > 0;
}

/**
 * Validate coordinates
 */
export function isValidCoordinate(lat: unknown, lng: unknown): boolean {
  if (typeof lat !== 'number' || typeof lng !== 'number') return false;
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

// ==================== VALIDATION RESPONSE ====================

export function validationErrorResponse(
  errors: Record<string, string>
): Response {
  return new Response(
    JSON.stringify({
      error: 'VALIDATION_ERROR',
      message: 'Invalid request data',
      details: errors,
    }),
    {
      status: 400,
      headers: jsonHeaders,
    }
  );
}

// ==================== CORS PREFLIGHT HANDLER ====================

export function handleCORSPreflight(): Response {
  return new Response(null, {
    status: 204,
    headers: securityHeaders,
  });
}

// ==================== SUCCESS/ERROR RESPONSES ====================

export function successResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: jsonHeaders,
  });
}

export function errorResponse(
  error: string,
  message: string,
  status = 500,
  details?: unknown
): Response {
  const body: Record<string, unknown> = { error, message };
  if (details !== undefined) {
    body.details = details;
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: jsonHeaders,
  });
}
