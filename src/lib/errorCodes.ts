/**
 * Platform-wide structured error codes.
 * Used by both backend edge functions and frontend error handling.
 * 
 * Convention: DOMAIN_ACTION_REASON
 * Every error code maps to a user-friendly message.
 */

export const ERROR_CODES = {
  // === Auth ===
  AUTH_SESSION_EXPIRED: 'Your session has expired. Please sign in again.',
  AUTH_UNAUTHORIZED: 'You are not authorized to perform this action.',
  AUTH_FORBIDDEN: 'Access denied. Insufficient permissions.',

  // === Validation ===
  VALIDATION_FAILED: 'Please check your input and try again.',
  VALIDATION_MISSING_FIELD: 'A required field is missing.',
  VALIDATION_INVALID_FORMAT: 'One or more fields have an invalid format.',

  // === Trip ===
  TRIP_NOT_FOUND: 'Trip not found.',
  TRIP_ALREADY_TAKEN: 'This ride has already been taken by another driver.',
  TRIP_NOT_AVAILABLE: 'This ride is no longer available.',
  TRIP_CANCEL_FAILED: 'Failed to cancel trip. Please try again.',

  // === Driver ===
  DRIVER_NOT_FOUND: 'Driver not found.',
  DRIVER_NOT_APPROVED: 'Driver account is not approved.',
  DRIVER_DOCUMENTS_INCOMPLETE: 'Required documents are missing or expired.',
  DRIVER_ALREADY_ONLINE: 'Driver is already online.',
  DRIVER_CANNOT_GO_ONLINE: 'Cannot go online. Please check your account status.',

  // === Offer ===
  OFFER_NOT_FOUND: 'Offer not found or already processed.',
  OFFER_EXPIRED: 'This offer has expired.',
  OFFER_ALREADY_RESPONDED: 'You have already responded to this offer.',
  OFFER_NOT_PENDING: 'This offer is no longer pending.',

  // === Payment ===
  PAYMENT_FAILED: 'Payment processing failed. Please try again.',
  PAYMENT_METHOD_INVALID: 'Invalid payment method.',
  PAYMENT_STRIPE_ERROR: 'Payment provider error. Please try again later.',
  PAYMENT_INSUFFICIENT_FUNDS: 'Insufficient funds.',

  // === Dispatch ===
  DISPATCH_NO_DRIVERS: 'No drivers available in your area.',
  DISPATCH_FAILED: 'Failed to dispatch trip. Please try again.',

  // === Document ===
  DOCUMENT_UPLOAD_FAILED: 'Document upload failed. Please try again.',
  DOCUMENT_TYPE_NOT_FOUND: 'Document type not found.',
  DOCUMENT_EXPIRED: 'This document has expired.',

  // === Rate Limit ===
  RATE_LIMIT_EXCEEDED: 'Too many requests. Please wait a moment and try again.',

  // === Network / Generic ===
  NETWORK_ERROR: 'Network error. Please check your connection and try again.',
  TIMEOUT: 'The request timed out. Please try again.',
  SERVER_ERROR: 'Something went wrong on our end. Please try again later.',
  UNKNOWN_ERROR: 'An unexpected error occurred. Please try again.',

  // === Corporate ===
  CORPORATE_ACCOUNT_NOT_FOUND: 'Corporate account not found.',
  CORPORATE_BUDGET_EXCEEDED: 'Monthly budget exceeded.',
  CORPORATE_USER_LIMIT_REACHED: 'User limit reached for this corporate account.',

  // === Geofence ===
  GEOFENCE_OUTSIDE_AREA: 'Location is outside the service area.',
  GEOFENCE_NO_SERVICE: 'Service is not available in this area.',
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

/**
 * Structured error response from backend edge functions
 */
export interface ApiErrorResponse {
  success: false;
  error: string;
  error_code?: ErrorCode;
  validation_errors?: string[];
  retry_allowed?: boolean;
}

/**
 * Get a user-friendly message for an error code.
 * Falls back to the raw error string if code is unknown.
 */
export function getErrorMessage(errorCode?: string, fallback?: string): string {
  if (errorCode && errorCode in ERROR_CODES) {
    return ERROR_CODES[errorCode as ErrorCode];
  }
  return fallback || ERROR_CODES.UNKNOWN_ERROR;
}

/**
 * Parse an API response or error into a user-friendly message.
 */
export function parseApiError(error: unknown): string {
  if (!error) return ERROR_CODES.UNKNOWN_ERROR;

  // Supabase/fetch error with message
  if (error instanceof Error) {
    if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
      return ERROR_CODES.NETWORK_ERROR;
    }
    if (error.message.includes('timeout') || error.message.includes('AbortError')) {
      return ERROR_CODES.TIMEOUT;
    }
    return error.message;
  }

  // Structured API error response
  if (typeof error === 'object' && error !== null) {
    const err = error as Record<string, unknown>;
    if (err.error_code && typeof err.error_code === 'string') {
      return getErrorMessage(err.error_code, err.error as string);
    }
    if (err.error && typeof err.error === 'string') {
      return err.error;
    }
    if (err.message && typeof err.message === 'string') {
      return err.message;
    }
  }

  if (typeof error === 'string') return error;

  return ERROR_CODES.UNKNOWN_ERROR;
}
