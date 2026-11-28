/** Offline test/audit-only helpers; not part of Edge uploads. */
import { VALID_PAYMENT_METHODS } from "../../../functions/_shared/security.ts";


export function isValidLatitude(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -90 && value <= 90;
}


export function isValidLongitude(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= -180 && value <= 180;
}


export function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}


export function isValidPaymentMethod(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false;
  return (VALID_PAYMENT_METHODS as readonly string[]).includes(value.trim().toUpperCase());
}

export * from "../../../functions/_shared/security.ts";
