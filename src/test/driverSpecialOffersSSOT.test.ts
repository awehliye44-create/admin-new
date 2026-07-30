import { describe, it, expect } from 'vitest';
import {
  buildDriverOffersBanner,
  buildDriverOffersPayload,
  describeOfferScope,
  formatUkPhoneForDisplay,
  isDriverEligible,
  isOfferLive,
  matchesOfferScope,
  normaliseUkPhone,
  selectDriverOffers,
  validateOfferScope,
  validateSpecialOfferDraft,
  SPECIAL_OFFERS_EMPTY_COPY,
  DEFAULT_BANNER_BUTTON_LABEL,
  type DriverEligibilityContext,
  type DriverSpecialOfferRow,
} from '../../shared/driverSpecialOffersSSOT';

const NOW = new Date('2026-06-15T12:00:00Z');

// Canonical fixtures mirroring production hierarchy.
const UK1 = 'region-uk1';
const SOMALIA = 'region-somalia';
const MK = 'sa-milton-keynes';
const LONDON = 'sa-london';
const LIVERPOOL = 'sa-liverpool';
const MANCHESTER = 'sa-manchester';
const MOGADISHU = 'sa-mogadishu';

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
  scope_type: 'selected_service_areas',
  region_id: null,
  created_at: '2026-01-01T00:00:00Z',
  ...over,
});

const driver = (over: Partial<DriverEligibilityContext> = {}): DriverEligibilityContext => ({
  service_area_id: MK,
  service_area_active: true,
  region_id: UK1,
  total_trips: 100,
  tier_name: 'Bronze',
  created_at: '2025-01-01T00:00:00Z',
  ...over,
});

describe('Offer visibility window', () => {
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

describe('Service-area scoping', () => {
  const mkOffer = offer({ id: 'mk', scope_type: 'selected_service_areas' });

  it('Milton Keynes driver receives Milton Keynes offers', () => {
    expect(matchesOfferScope(mkOffer, driver({ service_area_id: MK }), [MK])).toBe(true);
  });

  it('Milton Keynes driver does not receive London-only offers', () => {
    expect(matchesOfferScope(mkOffer, driver({ service_area_id: MK }), [LONDON])).toBe(false);
  });

  it('London driver receives London offers', () => {
    expect(
      matchesOfferScope(mkOffer, driver({ service_area_id: LONDON }), [LONDON]),
    ).toBe(true);
  });

  it('Liverpool driver does not receive Manchester-only offers', () => {
    expect(
      matchesOfferScope(mkOffer, driver({ service_area_id: LIVERPOOL }), [MANCHESTER]),
    ).toBe(false);
  });

  it('Mogadishu driver receives Mogadishu offers', () => {
    expect(
      matchesOfferScope(
        mkOffer,
        driver({ service_area_id: MOGADISHU, region_id: SOMALIA }),
        [MOGADISHU],
      ),
    ).toBe(true);
  });

  it('Mogadishu offer does not reach a Milton Keynes driver', () => {
    expect(matchesOfferScope(mkOffer, driver({ service_area_id: MK }), [MOGADISHU])).toBe(false);
  });
});

describe('Entire-region scoping', () => {
  const uk1Offer = offer({ scope_type: 'entire_region', region_id: UK1 });

  it('reaches all active UK1 service areas', () => {
    for (const sa of [MK, LONDON, LIVERPOOL, MANCHESTER]) {
      expect(matchesOfferScope(uk1Offer, driver({ service_area_id: sa, region_id: UK1 }), [])).toBe(true);
    }
  });

  it('does not reach Mogadishu', () => {
    expect(
      matchesOfferScope(uk1Offer, driver({ service_area_id: MOGADISHU, region_id: SOMALIA }), []),
    ).toBe(false);
  });

  it('does not reach a driver in an inactive service area', () => {
    expect(
      matchesOfferScope(uk1Offer, driver({ service_area_active: false }), []),
    ).toBe(false);
  });
});

describe('Global scoping', () => {
  const globalOffer = offer({ scope_type: 'global', region_id: null });

  it('reaches eligible drivers in multiple regions', () => {
    expect(matchesOfferScope(globalOffer, driver({ service_area_id: MK, region_id: UK1 }), [])).toBe(true);
    expect(
      matchesOfferScope(globalOffer, driver({ service_area_id: MOGADISHU, region_id: SOMALIA }), []),
    ).toBe(true);
  });

  it('is the only thing a driver with no resolved service area receives', () => {
    const noArea = driver({ service_area_id: null, service_area_active: false, region_id: null });
    const localOffer = offer({ id: 'local', scope_type: 'selected_service_areas' });
    const regionOffer = offer({ id: 'region', scope_type: 'entire_region', region_id: UK1 });
    const result = selectDriverOffers(
      [globalOffer, localOffer, regionOffer],
      { local: [MK] },
      noArea,
      NOW,
    );
    expect(result.map((o) => o.id)).toEqual([globalOffer.id]);
  });
});

describe('Inactive service areas', () => {
  it('does not return locally scoped offers through an inactive service area', () => {
    const localOffer = offer({ scope_type: 'selected_service_areas' });
    expect(
      isDriverEligible(localOffer, driver({ service_area_active: false }), [MK], NOW),
    ).toBe(false);
  });
});

describe('Driver eligibility rules', () => {
  it('filters by minimum completed trips', () => {
    const o = offer({ scope_type: 'global' , minimum_completed_trips: 250 });
    expect(isDriverEligible(o, driver({ total_trips: 100 }), [], NOW)).toBe(false);
    expect(isDriverEligible(o, driver({ total_trips: 250 }), [], NOW)).toBe(true);
  });

  it('filters new-drivers-only offers by signup age', () => {
    const o = offer({ scope_type: 'global', new_drivers_only: true });
    expect(isDriverEligible(o, driver({ created_at: '2025-01-01T00:00:00Z' }), [], NOW)).toBe(false);
    expect(isDriverEligible(o, driver({ created_at: '2026-06-01T00:00:00Z' }), [], NOW)).toBe(true);
  });

  it('filters by driver tier', () => {
    const o = offer({ scope_type: 'global', eligible_driver_tiers: ['Gold'] });
    expect(isDriverEligible(o, driver({ tier_name: 'Bronze' }), [], NOW)).toBe(false);
    expect(isDriverEligible(o, driver({ tier_name: 'Gold' }), [], NOW)).toBe(true);
  });
});

describe('Changing the driver service area changes the returned offers', () => {
  const londonOffer = offer({ id: 'london', scope_type: 'selected_service_areas' });
  const areaMap = { london: [LONDON] };

  it('MK driver sees nothing, London driver sees the offer', () => {
    expect(selectDriverOffers([londonOffer], areaMap, driver({ service_area_id: MK }), NOW)).toHaveLength(0);
    expect(
      selectDriverOffers([londonOffer], areaMap, driver({ service_area_id: LONDON }), NOW),
    ).toHaveLength(1);
  });
});

describe('Home banner', () => {
  it('hides completely when no eligible offer exists for the current service area', () => {
    const londonBanner = offer({ id: 'l', show_in_home_banner: true });
    const payload = buildDriverOffersPayload([londonBanner], { l: [LONDON] }, driver({ service_area_id: MK }), NOW);
    expect(payload.banner).toBeNull();
    expect(payload.empty).toBe(true);
    expect(payload.empty_copy).toBe(SPECIAL_OFFERS_EMPTY_COPY);
  });

  it('shows the highest-priority eligible offer deterministically', () => {
    const a = offer({ id: 'a', display_order: 2, show_in_home_banner: true, scope_type: 'global' });
    const b = offer({ id: 'b', display_order: 1, show_in_home_banner: true, scope_type: 'global' });
    const banner = buildDriverOffersBanner(selectDriverOffers([a, b], {}, driver(), NOW));
    expect(banner?.offer_id).toBe('b');
    expect(banner?.button_label).toBe(DEFAULT_BANNER_BUTTON_LABEL);
  });
});

describe('Availability-area validation', () => {
  const active = { [MK]: UK1, [LONDON]: UK1, [MOGADISHU]: SOMALIA };

  it('selected-service-area offer requires at least one assignment', () => {
    expect(
      validateOfferScope({ scope_type: 'selected_service_areas', serviceAreaIds: [], status: 'published' }),
    ).toContain('Select at least one service area for this offer.');
  });

  it('entire-region offer requires a region', () => {
    expect(
      validateOfferScope({ scope_type: 'entire_region', region_id: null, serviceAreaIds: [], status: 'published' }),
    ).toContain('Select a Region for an entire-region offer.');
  });

  it('global offer rejects region and service areas', () => {
    const errors = validateOfferScope({
      scope_type: 'global',
      region_id: UK1,
      serviceAreaIds: [MK],
      status: 'published',
    });
    expect(errors).toHaveLength(2);
  });

  it('rejects inactive service areas', () => {
    const errors = validateOfferScope({
      scope_type: 'selected_service_areas',
      serviceAreaIds: ['sa-archived'],
      status: 'published',
      activeServiceAreas: active,
    });
    expect(errors.join(' ')).toMatch(/inactive/i);
  });

  it('rejects service areas outside the selected region', () => {
    const errors = validateOfferScope({
      scope_type: 'selected_service_areas',
      region_id: UK1,
      serviceAreaIds: [MOGADISHU],
      status: 'published',
      activeServiceAreas: active,
    });
    expect(errors.join(' ')).toMatch(/must belong to the selected Region/i);
  });

  it('accepts a valid selected-service-area offer', () => {
    expect(
      validateOfferScope({
        scope_type: 'selected_service_areas',
        region_id: UK1,
        serviceAreaIds: [MK, LONDON],
        status: 'published',
        activeServiceAreas: active,
      }),
    ).toEqual([]);
  });
});

describe('Scope labels', () => {
  it('describes each scope type', () => {
    expect(describeOfferScope({ scope_type: 'global', region_id: null }, [])).toBe('Global');
    expect(
      describeOfferScope({ scope_type: 'entire_region', region_id: UK1 }, [], 'UK1'),
    ).toBe('All service areas in UK1');
    expect(
      describeOfferScope({ scope_type: 'selected_service_areas', region_id: null }, ['Milton Keynes']),
    ).toBe('Milton Keynes');
    expect(
      describeOfferScope({ scope_type: 'selected_service_areas', region_id: null }, [
        'Milton Keynes',
        'Birmingham',
        'Manchester',
        'London',
      ]),
    ).toBe('Milton Keynes, Birmingham +2 more');
  });
});

describe('Offer content validation', () => {
  it('requires a title, description and at least one action', () => {
    const errors = validateSpecialOfferDraft({ title: '', short_description: '', requires_action: true });
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });

  it('rejects non-https websites and bad emails', () => {
    const errors = validateSpecialOfferDraft({
      title: 'T',
      short_description: 'D',
      website_url: 'http://x.com',
      email_address: 'nope',
    });
    expect(errors).toHaveLength(2);
  });
});

describe('UK phone helpers', () => {
  it('normalises and formats UK numbers', () => {
    expect(normaliseUkPhone('07700 900123')).toBe('+447700900123');
    expect(formatUkPhoneForDisplay('+447700900123')).toBe('07700 900123');
    expect(normaliseUkPhone('nonsense')).toBeNull();
  });
});
