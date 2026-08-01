// Shared security utilities for all Edge Functions
// Import this file in any edge function that needs security features

// ============= SECURITY HEADERS =============
export const securityHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
  'Content-Type': 'application/json',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'X-XSS-Protection': '1; mode=block',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()',
};

// CORS headers for preflight requests (without Content-Type)
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
};

// ============= RATE LIMITING =============
// In-memory rate limiter (per edge function instance)
// Note: For production at scale, consider using Redis or a database-backed solution
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

interface RateLimitConfig {
  limit: number;        // Max requests allowed
  windowMs: number;     // Time window in milliseconds
}

const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  limit: 100,           // 100 requests
  windowMs: 60 * 1000,  // per minute
};

/**
 * Check if a request should be rate limited
 * @param identifier - Unique identifier (e.g., IP address, user ID)
 * @param config - Rate limit configuration
 * @returns { allowed: boolean, remaining: number, resetAt: number }
 */
export function checkRateLimit(
  identifier: string,
  config: RateLimitConfig = DEFAULT_RATE_LIMIT
): { allowed: boolean; remaining: number; resetAt: number; retryAfter?: number } {
  const now = Date.now();
  const record = rateLimitStore.get(identifier);

  // Clean up expired entries periodically
  if (rateLimitStore.size > 10000) {
    for (const [key, value] of rateLimitStore.entries()) {
      if (value.resetAt < now) {
        rateLimitStore.delete(key);
      }
    }
  }

  if (!record || record.resetAt < now) {
    // First request or window expired - start new window
    const resetAt = now + config.windowMs;
    rateLimitStore.set(identifier, { count: 1, resetAt });
    return { allowed: true, remaining: config.limit - 1, resetAt };
  }

  if (record.count >= config.limit) {
    // Rate limit exceeded
    const retryAfter = Math.ceil((record.resetAt - now) / 1000);
    return { allowed: false, remaining: 0, resetAt: record.resetAt, retryAfter };
  }

  // Increment counter
  record.count++;
  rateLimitStore.set(identifier, record);
  return { allowed: true, remaining: config.limit - record.count, resetAt: record.resetAt };
}

/**
 * Get client IP from request headers
 */
export function getClientIP(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
         req.headers.get('x-real-ip') ||
         req.headers.get('cf-connecting-ip') ||
         'unknown';
}

/**
 * Create a rate limit exceeded response
 */
export function rateLimitResponse(retryAfter: number): Response {
  return new Response(
    JSON.stringify({
      success: false,
      error: 'Rate limit exceeded',
      message: 'Too many requests. Please try again later.',
      retryAfter,
    }),
    {
      status: 429,
      headers: {
        ...securityHeaders,
        'Retry-After': String(retryAfter),
      },
    }
  );
}

// ============= INPUT VALIDATION HELPERS =============

/**
 * Validate UUID format
 */
export function isValidUUID(str: string): boolean {
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(str);
}

/**
 * Sanitize string input - remove potential XSS vectors
 */
export function sanitizeString(str: string, maxLength: number = 1000): string {
  if (typeof str !== 'string') return '';
  return str
    .slice(0, maxLength)
    .replace(/<[^>]*>/g, '')  // Remove HTML tags
    .replace(/[<>'"&]/g, (char) => {
      const entities: Record<string, string> = {
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;',
        '&': '&amp;',
      };
      return entities[char] || char;
    })
    .trim();
}

/**
 * Validate coordinate (latitude or longitude)
 */
export function isValidLatitude(lat: number): boolean {
  return typeof lat === 'number' && !isNaN(lat) && lat >= -90 && lat <= 90;
}

export function isValidLongitude(lng: number): boolean {
  return typeof lng === 'number' && !isNaN(lng) && lng >= -180 && lng <= 180;
}

/**
 * Validate positive integer
 */
export function isPositiveInteger(num: number): boolean {
  return typeof num === 'number' && Number.isInteger(num) && num > 0;
}

/**
 * Validate payment method — ONECAB is digital-only.
 */
export function isValidPaymentMethod(method: string): boolean {
  const validMethods = ['CARD', 'WALLET', 'APPLE_PAY', 'GOOGLE_PAY', 'REVOLUT', 'CORPORATE_ACCOUNT'];
  return validMethods.includes(method);
}

// ============= ERROR RESPONSES =============

export function errorResponse(
  message: string,
  status: number = 400,
  details?: Record<string, unknown>,
  errorCode?: string
): Response {
  return new Response(
    JSON.stringify({
      success: false,
      error: message,
      error_code: errorCode || null,
      retry_allowed: status >= 500, // Server errors are retryable
      ...details,
    }),
    {
      status,
      headers: securityHeaders,
    }
  );
}

export function validationErrorResponse(errors: string[]): Response {
  return new Response(
    JSON.stringify({
      success: false,
      error: 'Validation failed',
      error_code: 'VALIDATION_FAILED',
      validation_errors: errors,
      retry_allowed: false,
    }),
    {
      status: 400,
      headers: securityHeaders,
    }
  );
}

// ============= SUCCESS RESPONSE =============

export function successResponse(data: Record<string, unknown>, status: number = 200): Response {
  return new Response(
    JSON.stringify({
      success: true,
      ...data,
    }),
    {
      status,
      headers: securityHeaders,
    }
  );
}

// ============= AUDIT LOGGING =============

/**
 * Log an audit event to the database
 */
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
  } = {}
): Promise<void> {
  try {
    await supabase.rpc('log_audit_event', {
      p_event_type: eventType,
      p_user_id: options.userId || null,
      p_driver_id: options.driverId || null,
      p_trip_id: options.tripId || null,
      p_details: options.details || {},
      p_ip_address: options.ipAddress || null,
      p_user_agent: options.userAgent || null,
    });
  } catch (error) {
    console.error('[audit] Failed to log audit event:', eventType, error);
  }
}
