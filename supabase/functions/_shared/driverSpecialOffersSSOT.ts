/**
 * Driver Special Offers SSOT — pure eligibility / visibility rules.
 * Used by Admin panel, the read Edge Function and tests.
 * The Driver app never decides eligibility on-device: the Edge Function applies these rules.
 */

export interface DriverSpecialOfferRow {
  id: string;
  category_id: string | null;
  title: string;
  partner_name: string | null;
  short_description: string;
  full_details: string | null;
  badge_label: string | null;
  image_path: string | null;
  website_url: string | null;
  phone_number: string | null;
  email_address: string | null;
  promo_code: string | null;
  internal_route: string | null;
  website_button_label: string | null;
  phone_button_label: string | null;
  email_button_label: string | null;
  banner_headline: string | null;
  banner_button_label: string | null;
  status: 'draft' | 'published' | 'archived';
  is_active: boolean;
  is_featured: boolean;
  show_in_home_banner: boolean;
  show_in_offer_list: boolean;
  starts_at: string | null;
  ends_at: string | null;
  minimum_completed_trips: number | null;
  new_drivers_only: boolean;
  eligible_driver_tiers: string[] | null;
  display_order: number;
}

export interface DriverEligibilityContext {
  /** drivers.service_area_id */
  service_area_id: string | null;
  /** drivers.total_trips (completed-trip counter SSOT) */
  total_trips: number;
  /** driver_categories.name via drivers.category_id */
  tier_name: string | null;
  /** drivers.created_at */
  created_at: string | null;
}

export const NEW_DRIVER_WINDOW_DAYS = 30;
export const SPECIAL_OFFERS_EMPTY_COPY = 'No special offers are available right now.';
export const DEFAULT_BANNER_BUTTON_LABEL = 'View offers';

export function isOfferLive(offer: DriverSpecialOfferRow, now: Date = new Date()): boolean {
  if (offer.status !== 'published') return false;
  if (!offer.is_active) return false;
  const t = now.getTime();
  if (offer.starts_at && new Date(offer.starts_at).getTime() > t) return false;
  if (offer.ends_at && new Date(offer.ends_at).getTime() <= t) return false;
  return true;
}

export function isDriverEligible(
  offer: DriverSpecialOfferRow,
  driver: DriverEligibilityContext,
  serviceAreaIds: string[],
  now: Date = new Date(),
): boolean {
  // Service area scoping: no rows = global.
  if (serviceAreaIds.length > 0) {
    if (!driver.service_area_id || !serviceAreaIds.includes(driver.service_area_id)) return false;
  }
  if (offer.minimum_completed_trips != null && driver.total_trips < offer.minimum_completed_trips) return false;
  if (offer.new_drivers_only) {
    if (!driver.created_at) return false;
    const ageDays = (now.getTime() - new Date(driver.created_at).getTime()) / 86_400_000;
    if (ageDays > NEW_DRIVER_WINDOW_DAYS) return false;
  }
  const tiers = offer.eligible_driver_tiers;
  if (tiers && tiers.length > 0) {
    if (!driver.tier_name) return false;
    if (!tiers.some((t) => t.toLowerCase() === driver.tier_name!.toLowerCase())) return false;
  }
  return true;
}

export function sortOffers<T extends { is_featured: boolean; display_order: number; title: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.is_featured !== b.is_featured) return a.is_featured ? -1 : 1;
    if (a.display_order !== b.display_order) return a.display_order - b.display_order;
    return a.title.localeCompare(b.title);
  });
}

export interface OfferAreaMap {
  [offerId: string]: string[];
}

export function selectDriverOffers(
  offers: DriverSpecialOfferRow[],
  areaMap: OfferAreaMap,
  driver: DriverEligibilityContext,
  now: Date = new Date(),
): DriverSpecialOfferRow[] {
  return sortOffers(
    offers.filter(
      (o) => isOfferLive(o, now) && isDriverEligible(o, driver, areaMap[o.id] ?? [], now),
    ),
  );
}

export interface DriverOffersBanner {
  headline: string;
  button_label: string;
  offer_id: string;
}

/** Banner is only returned when a banner-eligible live offer exists. */
export function buildDriverOffersBanner(eligible: DriverSpecialOfferRow[]): DriverOffersBanner | null {
  const banner = eligible.find((o) => o.show_in_home_banner);
  if (!banner) return null;
  return {
    headline: banner.banner_headline?.trim() || 'Special offers just for you!',
    button_label: banner.banner_button_label?.trim() || DEFAULT_BANNER_BUTTON_LABEL,
    offer_id: banner.id,
  };
}

export function buildDriverOffersPayload(
  offers: DriverSpecialOfferRow[],
  areaMap: OfferAreaMap,
  driver: DriverEligibilityContext,
  now: Date = new Date(),
) {
  const eligible = selectDriverOffers(offers, areaMap, driver, now);
  const list = eligible.filter((o) => o.show_in_offer_list);
  return {
    banner: buildDriverOffersBanner(eligible),
    offers: list,
    empty: list.length === 0,
    empty_copy: SPECIAL_OFFERS_EMPTY_COPY,
  };
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
  if (input.phone_number && normaliseUkPhone(input.phone_number) === null) {
    errors.push('Phone number is not a valid UK number.');
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

/** Normalise UK numbers to E.164 (+44…). Returns null when invalid. */
export function normaliseUkPhone(input: string): string | null {
  const digits = input.replace(/[^\d+]/g, '');
  let national: string | null = null;
  if (digits.startsWith('+44')) national = digits.slice(3);
  else if (digits.startsWith('0044')) national = digits.slice(4);
  else if (digits.startsWith('44') && digits.length >= 12) national = digits.slice(2);
  else if (digits.startsWith('0')) national = digits.slice(1);
  else return null;
  national = national.replace(/^0+/, '');
  if (!/^\d{9,10}$/.test(national)) return null;
  return `+44${national}`;
}

/** Readable UK display format, e.g. +447700900123 -> 07700 900123. */
export function formatUkPhoneForDisplay(e164OrRaw: string): string {
  const e164 = normaliseUkPhone(e164OrRaw);
  if (!e164) return e164OrRaw;
  const national = `0${e164.slice(3)}`;
  if (national.length === 11) return `${national.slice(0, 5)} ${national.slice(5)}`;
  return national;
}
