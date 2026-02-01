// Zod-like validation schemas for Edge Functions
// Using a lightweight custom implementation since we can't use npm packages directly

export interface ValidationResult<T> {
  success: boolean;
  data?: T;
  errors?: string[];
}

// ============= UUID VALIDATOR =============
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateUUID(value: unknown, fieldName: string): ValidationResult<string> {
  if (typeof value !== 'string') {
    return { success: false, errors: [`${fieldName} must be a string`] };
  }
  if (!UUID_REGEX.test(value)) {
    return { success: false, errors: [`${fieldName} must be a valid UUID`] };
  }
  return { success: true, data: value };
}

// ============= STRING VALIDATOR =============
export function validateString(
  value: unknown,
  fieldName: string,
  options: { minLength?: number; maxLength?: number; optional?: boolean } = {}
): ValidationResult<string | undefined> {
  const { minLength = 0, maxLength = 10000, optional = false } = options;
  
  if (value === undefined || value === null) {
    if (optional) return { success: true, data: undefined };
    return { success: false, errors: [`${fieldName} is required`] };
  }
  
  if (typeof value !== 'string') {
    return { success: false, errors: [`${fieldName} must be a string`] };
  }
  
  const trimmed = value.trim();
  
  if (trimmed.length < minLength) {
    return { success: false, errors: [`${fieldName} must be at least ${minLength} characters`] };
  }
  
  if (trimmed.length > maxLength) {
    return { success: false, errors: [`${fieldName} must be at most ${maxLength} characters`] };
  }
  
  return { success: true, data: trimmed };
}

// ============= NUMBER VALIDATOR =============
export function validateNumber(
  value: unknown,
  fieldName: string,
  options: { min?: number; max?: number; integer?: boolean; optional?: boolean } = {}
): ValidationResult<number | undefined> {
  const { min, max, integer = false, optional = false } = options;
  
  if (value === undefined || value === null) {
    if (optional) return { success: true, data: undefined };
    return { success: false, errors: [`${fieldName} is required`] };
  }
  
  const num = typeof value === 'string' ? parseFloat(value) : value;
  
  if (typeof num !== 'number' || isNaN(num)) {
    return { success: false, errors: [`${fieldName} must be a number`] };
  }
  
  if (integer && !Number.isInteger(num)) {
    return { success: false, errors: [`${fieldName} must be an integer`] };
  }
  
  if (min !== undefined && num < min) {
    return { success: false, errors: [`${fieldName} must be at least ${min}`] };
  }
  
  if (max !== undefined && num > max) {
    return { success: false, errors: [`${fieldName} must be at most ${max}`] };
  }
  
  return { success: true, data: num };
}

// ============= LATITUDE VALIDATOR =============
export function validateLatitude(value: unknown, fieldName: string = 'latitude'): ValidationResult<number> {
  const result = validateNumber(value, fieldName, { min: -90, max: 90 });
  if (!result.success) return result as ValidationResult<number>;
  return { success: true, data: result.data! };
}

// ============= LONGITUDE VALIDATOR =============
export function validateLongitude(value: unknown, fieldName: string = 'longitude'): ValidationResult<number> {
  const result = validateNumber(value, fieldName, { min: -180, max: 180 });
  if (!result.success) return result as ValidationResult<number>;
  return { success: true, data: result.data! };
}

// ============= ENUM VALIDATOR =============
export function validateEnum<T extends string>(
  value: unknown,
  fieldName: string,
  allowedValues: readonly T[],
  options: { optional?: boolean } = {}
): ValidationResult<T | undefined> {
  const { optional = false } = options;
  
  if (value === undefined || value === null) {
    if (optional) return { success: true, data: undefined };
    return { success: false, errors: [`${fieldName} is required`] };
  }
  
  if (typeof value !== 'string') {
    return { success: false, errors: [`${fieldName} must be a string`] };
  }
  
  if (!allowedValues.includes(value as T)) {
    return { success: false, errors: [`${fieldName} must be one of: ${allowedValues.join(', ')}`] };
  }
  
  return { success: true, data: value as T };
}

// ============= PAYMENT METHOD VALIDATOR =============
const PAYMENT_METHODS = ['CASH', 'CARD', 'WALLET', 'APPLE_PAY', 'GOOGLE_PAY'] as const;
export type PaymentMethod = typeof PAYMENT_METHODS[number];

export function validatePaymentMethod(value: unknown, fieldName: string = 'payment_method'): ValidationResult<PaymentMethod> {
  return validateEnum(value, fieldName, PAYMENT_METHODS) as ValidationResult<PaymentMethod>;
}

// ============= SCHEMA VALIDATOR =============
export interface SchemaField {
  type: 'uuid' | 'string' | 'number' | 'latitude' | 'longitude' | 'enum' | 'payment_method';
  optional?: boolean;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  integer?: boolean;
  enumValues?: readonly string[];
}

export function validateSchema<T>(
  data: unknown,
  schema: Record<string, SchemaField>
): ValidationResult<T> {
  if (typeof data !== 'object' || data === null) {
    return { success: false, errors: ['Request body must be an object'] };
  }
  
  const errors: string[] = [];
  const result: Record<string, unknown> = {};
  const obj = data as Record<string, unknown>;
  
  for (const [fieldName, fieldSchema] of Object.entries(schema)) {
    const value = obj[fieldName];
    let validationResult: ValidationResult<unknown>;
    
    switch (fieldSchema.type) {
      case 'uuid':
        if (fieldSchema.optional && (value === undefined || value === null)) {
          validationResult = { success: true, data: undefined };
        } else {
          validationResult = validateUUID(value, fieldName);
        }
        break;
        
      case 'string':
        validationResult = validateString(value, fieldName, {
          minLength: fieldSchema.minLength,
          maxLength: fieldSchema.maxLength,
          optional: fieldSchema.optional,
        });
        break;
        
      case 'number':
        validationResult = validateNumber(value, fieldName, {
          min: fieldSchema.min,
          max: fieldSchema.max,
          integer: fieldSchema.integer,
          optional: fieldSchema.optional,
        });
        break;
        
      case 'latitude':
        if (fieldSchema.optional && (value === undefined || value === null)) {
          validationResult = { success: true, data: undefined };
        } else {
          validationResult = validateLatitude(value, fieldName);
        }
        break;
        
      case 'longitude':
        if (fieldSchema.optional && (value === undefined || value === null)) {
          validationResult = { success: true, data: undefined };
        } else {
          validationResult = validateLongitude(value, fieldName);
        }
        break;
        
      case 'enum':
        validationResult = validateEnum(value, fieldName, fieldSchema.enumValues || [], {
          optional: fieldSchema.optional,
        });
        break;
        
      case 'payment_method':
        if (fieldSchema.optional && (value === undefined || value === null)) {
          validationResult = { success: true, data: undefined };
        } else {
          validationResult = validatePaymentMethod(value, fieldName);
        }
        break;
        
      default:
        validationResult = { success: true, data: value };
    }
    
    if (!validationResult.success) {
      errors.push(...(validationResult.errors || []));
    } else if (validationResult.data !== undefined) {
      result[fieldName] = validationResult.data;
    }
  }
  
  if (errors.length > 0) {
    return { success: false, errors };
  }
  
  return { success: true, data: result as T };
}

// ============= SPECIFIC SCHEMA DEFINITIONS =============

export interface AcceptTripRequest {
  trip_id: string;
  driver_id: string;
}

export const acceptTripSchema: Record<keyof AcceptTripRequest, SchemaField> = {
  trip_id: { type: 'uuid' },
  driver_id: { type: 'uuid' },
};

export interface DeclineTripRequest {
  trip_id: string;
  driver_id: string;
  reason?: string;
}

export const declineTripSchema: Record<keyof DeclineTripRequest, SchemaField> = {
  trip_id: { type: 'uuid' },
  driver_id: { type: 'uuid' },
  reason: { type: 'string', optional: true, maxLength: 500 },
};

export interface DispatchTripRequest {
  trip_id: string;
  pickup_lat: number;
  pickup_lng: number;
  vehicle_type_id?: string;
  max_distance_km?: number;
  max_drivers?: number;
  offer_timeout_seconds?: number;
}

export const dispatchTripSchema: Record<keyof DispatchTripRequest, SchemaField> = {
  trip_id: { type: 'uuid' },
  pickup_lat: { type: 'latitude' },
  pickup_lng: { type: 'longitude' },
  vehicle_type_id: { type: 'uuid', optional: true },
  max_distance_km: { type: 'number', optional: true, min: 1, max: 100 },
  max_drivers: { type: 'number', optional: true, min: 1, max: 50, integer: true },
  offer_timeout_seconds: { type: 'number', optional: true, min: 10, max: 300, integer: true },
};

export interface CompleteTripRequest {
  trip_id: string;
  driver_id: string;
  final_fare_pence: number;
  payment_method: PaymentMethod;
  stripe_payment_intent_id?: string;
}

export const completeTripSchema: Record<keyof CompleteTripRequest, SchemaField> = {
  trip_id: { type: 'uuid' },
  driver_id: { type: 'uuid' },
  final_fare_pence: { type: 'number', min: 0, max: 100000000, integer: true },
  payment_method: { type: 'payment_method' },
  stripe_payment_intent_id: { type: 'string', optional: true, maxLength: 255 },
};

export interface FindDriversRequest {
  pickup_lat: number;
  pickup_lng: number;
  vehicle_type_id?: string;
  max_distance_km?: number;
}

export const findDriversSchema: Record<keyof FindDriversRequest, SchemaField> = {
  pickup_lat: { type: 'latitude' },
  pickup_lng: { type: 'longitude' },
  vehicle_type_id: { type: 'uuid', optional: true },
  max_distance_km: { type: 'number', optional: true, min: 1, max: 100 },
};

export interface CheckGeofenceRequest {
  driver_id: string;
  lat: number;
  lng: number;
  prev_lat?: number;
  prev_lng?: number;
  trip_id?: string;
}

export const checkGeofenceSchema: Record<keyof CheckGeofenceRequest, SchemaField> = {
  driver_id: { type: 'uuid' },
  lat: { type: 'latitude' },
  lng: { type: 'longitude' },
  prev_lat: { type: 'latitude', optional: true },
  prev_lng: { type: 'longitude', optional: true },
  trip_id: { type: 'uuid', optional: true },
};
