/** Admin presentation-only helpers; not part of Edge uploads. */
import { OfferScopeType, DriverSpecialOfferRow, normaliseUkPhone } from "../../supabase/functions/_shared/driverSpecialOffersSSOT.ts";


export const OFFER_SCOPE_TYPES: OfferScopeType[] = [
  'selected_service_areas',
  'entire_region',
  'global',
];

export const GLOBAL_SCOPE_CONFIRMATION =
  'This offer will be visible across all active service areas.';


/** Availability-area validation SSOT (mirrors the database triggers). */
export function validateOfferScope(input: {
  scope_type: OfferScopeType;
  region_id?: string | null;
  serviceAreaIds: string[];
  status: 'draft' | 'published' | 'archived';
  /** Active service areas keyed by id -> region_id. Optional; when supplied, membership is checked. */
  activeServiceAreas?: Record<string, string>;
}): string[] {
  const errors: string[] = [];
  const areas = input.serviceAreaIds ?? [];

  if (input.scope_type === 'global') {
    if (input.region_id) errors.push('A global offer cannot be tied to a Region.');
    if (areas.length) errors.push('A global offer cannot have service areas assigned.');
    return errors;
  }

  if (input.scope_type === 'entire_region') {
    if (!input.region_id) errors.push('Select a Region for an entire-region offer.');
    return errors;
  }

  // selected_service_areas
  if (areas.length === 0) {
    errors.push('Select at least one service area for this offer.');
  }
  if (input.activeServiceAreas) {
    for (const id of areas) {
      const regionId = input.activeServiceAreas[id];
      if (!regionId) {
        errors.push('One or more selected service areas are inactive or no longer exist.');
        break;
      }
    }
    if (input.region_id) {
      const mismatch = areas.some(
        (id) => input.activeServiceAreas![id] && input.activeServiceAreas![id] !== input.region_id,
      );
      if (mismatch) errors.push('Selected service areas must belong to the selected Region.');
    }
  }
  return errors;
}


/** Human-readable scope label for the Admin table. */
export function describeOfferScope(
  offer: Pick<DriverSpecialOfferRow, 'scope_type' | 'region_id'>,
  serviceAreaNames: string[],
  regionName?: string | null,
): string {
  if (offer.scope_type === 'global') return 'Global';
  if (offer.scope_type === 'entire_region') {
    return `All service areas in ${regionName ?? 'selected Region'}`;
  }
  if (serviceAreaNames.length === 0) return 'No service areas';
  if (serviceAreaNames.length === 1) return serviceAreaNames[0];
  if (serviceAreaNames.length === 2) return serviceAreaNames.join(', ');
  return `${serviceAreaNames.slice(0, 2).join(', ')} +${serviceAreaNames.length - 2} more`;
}


/** Admin validation SSOT. Returns a list of human-readable errors. */
export function validateSpecialOfferDraft(input: {
  title: string;
  short_description: string;
  website_url?: string | null;
  phone_number?: string | null;
  email_address?: string | null;
  promo_code?: string | null;
  internal_route?: string | null;
  starts_at?: string | null;
  ends_at?: string | null;
  requires_action?: boolean;
}): string[] {
  const errors: string[] = [];
  if (!input.title.trim()) errors.push('Offer title is required.');
  if (!input.short_description.trim()) errors.push('Short description is required.');
  if (input.website_url && !/^https:\/\/\S+$/i.test(input.website_url.trim())) {
    errors.push('Website URL must be a valid https:// address.');
  }
  if (input.email_address && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email_address.trim())) {
    errors.push('Email address is not valid.');
  }
  if (input.starts_at && input.ends_at && new Date(input.ends_at) < new Date(input.starts_at)) {
    errors.push('End date cannot be before start date.');
  }
  if (input.requires_action) {
    const hasAction = Boolean(
      input.website_url || input.phone_number || input.email_address || input.promo_code || input.internal_route,
    );
    if (!hasAction) errors.push('At least one action (website, phone, email, promo code or route) is required.');
  }
  return errors;
}


/** Readable UK display format, e.g. +447700900123 -> 07700 900123. */
export function formatUkPhoneForDisplay(e164OrRaw: string): string {
  const e164 = normaliseUkPhone(e164OrRaw);
  if (!e164) return e164OrRaw;
  const national = `0${e164.slice(3)}`;
  if (national.length === 11) return `${national.slice(0, 5)} ${national.slice(5)}`;
  return national;
}
