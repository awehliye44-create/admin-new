import { describe, it, expect } from 'vitest';
import {
  buildDriverOffersBanner,
  buildDriverOffersPayload,
  formatUkPhoneForDisplay,
  isDriverEligible,
  isOfferLive,
  normaliseUkPhone,
  selectDriverOffers,
  validateSpecialOfferDraft,
  SPECIAL_OFFERS_EMPTY_COPY,
  DEFAULT_BANNER_BUTTON_LABEL,
  type DriverEligibilityContext,
  type DriverSpecialOfferRow,
} from '../../shared/driverSpecialOffersSSOT';

const NOW = new Date('2026-06-15T12:00:00Z');

const offer = (over: Partial<DriverSpecialOfferRow> = {}): DriverSpecialOfferRow => ({
  id: 'o1',
  category_id: null,
  title: 'Fuel discount',
  partner_name: 'Partner',
  short_description: 'Save on fuel',
  full_details: null,
  badge_label: 'Fuel',
  image_path: null,
  website_url: 'https://example.com',
  phone_number: null,
  email_address: null,
  promo_code: null,
  internal_route: null,
  website_button_label: null,
  phone_button_label: null,
  email_button_label: null,
  banner_headline: null,
  banner_button_label: null,
  status: 'published',
  is_active: true,
  is_featured: false,
  show_in_home_banner: false,
  show_in_offer_list: true,
  starts_at: '2026-01-01T00:00:00Z',
  ends_at: null,
  minimum_completed_trips: null,
  new_drivers_only: false,
  eligible_driver_tiers: null,
  display_order: 0,
  ...over,
});

const driver = (over: Partial<DriverEligibilityContext> = {}): DriverEligibilityContext => ({
  service_area_id: 'sa-mk',
  total_trips: 100,
  tier_name: 'Bronze',
  created_at: '2025-01-01T00:00:00Z',
  ...over,
});

describe('Driver special offers visibility', () => {
  it('hides draft offers', () => {
    expect(isOfferLive(offer({ status: 'draft' }), NOW)).toBe(false);
  });

  it('hides archived offers', () => {
    expect(isOfferLive(offer({ status: 'archived' }), NOW)).toBe(false);
  });

  it('hides inactive offers', () => {
    expect(isOfferLive(offer({ is_active: false }), NOW)).toBe(false);
  });

  it('hides future offers until the start date', () => {
    expect(isOfferLive(offer({ starts_at: '2026-07-01T00:00:00Z' }), NOW)).toBe(false);
  });

  it('hides expired offers', () => {
    expect(isOfferLive(offer({ ends_at: '2026-06-01T00:00:00Z' }), NOW)).toBe(false);
  });

  it('shows a published, active, in-date offer', () => {
    expect(isOfferLive(offer(), NOW)).toBe(true);
  });
});

describe('Driver eligibility filtering', () => {
  it('filters by service area when configured', () => {
    expect(isDriverEligible(offer(), driver(), ['sa-other'], NOW)).toBe(false);
    expect(isDriverEligible(offer(), driver(), ['sa-mk'], NOW)).toBe(true);
    expect(isDriverEligible(offer(), driver(), [], NOW)).toBe(true); // global
  });

  it('filters by minimum completed trips', () => {
    const o = offer({ minimum_completed_trips: 250 });
    expect(isDriverEligible(o, driver({ total_trips: 100 }), [], NOW)).toBe(false);
    expect(isDriverEligible(o, driver({ total_trips: 250 }), [], NOW)).toBe(true);
  });

  it('filters new-drivers-only offers by signup age', () => {
    const o = offer({ new_drivers_only: true });
    expect(isDriverEligible(o, driver({ created_at: '2025-01-01T00:00:00Z' }), [], NOW)).toBe(false);
    expect(isDriverEligible(o, driver({ created_at: '2026-06-01T00:00:00Z' }), [], NOW)).toBe(true);
  });

  it('filters by driver tier', () => {
    const o = offer({ eligible_driver_tiers: ['Gold'] });
    expect(isDriverEligible(o, driver({ tier_name: 'Bronze' }), [], NOW)).toBe(false);
    expect(isDriverEligible(o, driver({ tier_name: 'gold' }), [], NOW)).toBe(true);
  });
});

describe('Driver offers payload and banner', () => {
  it('hides the banner when no banner-eligible offer exists', () => {
    const payload = buildDriverOffersPayload([offer()], {}, driver(), NOW);
    expect(payload.banner).toBeNull();
    expect(payload.offers).toHaveLength(1);
  });

  it('returns admin-managed banner headline and button label', () => {
    const eligible = selectDriverOffers(
      [offer({ show_in_home_banner: true, banner_headline: 'Deals for you', banner_button_label: 'See deals' })],
      {},
      driver(),
      NOW,
    );
    expect(buildDriverOffersBanner(eligible)).toEqual({
      headline: 'Deals for you',
      button_label: 'See deals',
      offer_id: 'o1',
    });
  });

  it('falls back to the locked default button label', () => {
    const eligible = selectDriverOffers([offer({ show_in_home_banner: true })], {}, driver(), NOW);
    expect(buildDriverOffersBanner(eligible)?.button_label).toBe(DEFAULT_BANNER_BUTTON_LABEL);
  });

  it('never returns placeholder offers and uses the canonical empty copy', () => {
    const payload = buildDriverOffersPayload([offer({ status: 'draft' })], {}, driver(), NOW);
    expect(payload.offers).toHaveLength(0);
    expect(payload.empty).toBe(true);
    expect(payload.empty_copy).toBe(SPECIAL_OFFERS_EMPTY_COPY);
  });

  it('excludes offers hidden from the list but still allows them to drive the banner', () => {
    const payload = buildDriverOffersPayload(
      [offer({ show_in_offer_list: false, show_in_home_banner: true })],
      {},
      driver(),
      NOW,
    );
    expect(payload.offers).toHaveLength(0);
    expect(payload.banner?.offer_id).toBe('o1');
  });
});

describe('Special offer admin validation', () => {
  it('rejects non-https website URLs', () => {
    const errors = validateSpecialOfferDraft({
      title: 'T',
      short_description: 'D',
      website_url: 'http://example.com',
    });
    expect(errors).toContain('Website URL must be a valid https:// address.');
  });

  it('rejects an end date before the start date', () => {
    const errors = validateSpecialOfferDraft({
      title: 'T',
      short_description: 'D',
      starts_at: '2026-06-10T00:00:00Z',
      ends_at: '2026-06-01T00:00:00Z',
    });
    expect(errors).toContain('End date cannot be before start date.');
  });

  it('requires at least one action when the offer needs redemption', () => {
    expect(validateSpecialOfferDraft({ title: 'T', short_description: 'D', requires_action: true })).toContain(
      'At least one action (website, phone, email, promo code or route) is required.',
    );
    expect(
      validateSpecialOfferDraft({ title: 'T', short_description: 'D', promo_code: 'ABC', requires_action: true }),
    ).toHaveLength(0);
  });

  it('normalises and formats UK phone numbers', () => {
    expect(normaliseUkPhone('07700 900123')).toBe('+447700900123');
    expect(normaliseUkPhone('+44 7700 900123')).toBe('+447700900123');
    expect(normaliseUkPhone('12')).toBeNull();
    expect(formatUkPhoneForDisplay('+447700900123')).toBe('07700 900123');
  });
});
