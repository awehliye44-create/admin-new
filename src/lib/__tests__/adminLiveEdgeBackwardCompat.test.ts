/**
 * Frontend backward-compatibility with live/legacy Edge response shapes.
 *
 * Website may publish on #38 merge before Edge redeploy. UI must:
 * A) tolerate current live (pre-#38) Edge payloads
 * B) render new #38 component fields when present
 * C) treat missing/null legacy fields as Unknown / omit chips — never invent £0.00
 */
import { describe, expect, it } from 'vitest';
import {
  ADMIN_FARE_COMPONENT_UNKNOWN,
  buildTipAirportChips,
  formatStoredPenceOrUnknown,
  isPositiveStoredPence,
  resolveTripAirportPence,
  resolveTripTipPence,
  storedPenceDifference,
  sumKnownEntitlementComponentsPence,
} from '@/lib/adminFareComponentDisplay';

/** Legacy FR trip audit row (live Edge before tip/airport component fields). */
type LegacyFrTripRow = {
  trip_id: string;
  driver_net_pence: number | null;
  captured_pence: number | null;
  wallet_credit_pence: number | null;
  expected_driver_credit_pence?: number | null;
  actual_driver_credit_pence?: number | null;
  credit_difference_pence?: number | null;
  driver_credit_health?: string | null;
  capture_breakdown?: {
    ride_fare_pence: number | null;
    pickup_waiting_charge_pence: number | null;
    stop_waiting_charge_pence: number | null;
    expected_capture_pence: number | null;
    provider_captured_pence: number | null;
    variance_pence: number | null;
    variance_reason: string | null;
    capture_classification: string;
    // tip/airport intentionally absent on live Edge
  } | null;
  // optional stamps may be absent on some legacy rows
  tip_pence?: number | null;
  airport_charge_pence?: number | null;
  expected_fare_net_pence?: number | null;
  expected_airport_component_pence?: number | null;
  expected_tip_component_pence?: number | null;
  actual_trip_earning_net_pence?: number | null;
  actual_settlement_corrections_pence?: number | null;
  actual_tip_credit_pence?: number | null;
};

/** New #38 FR component fields on top of legacy. */
type NewFrTripRow = LegacyFrTripRow & {
  tip_pence?: number | null;
  airport_charge_pence?: number | null;
  expected_fare_net_pence?: number | null;
  expected_airport_component_pence?: number | null;
  expected_tip_component_pence?: number | null;
  actual_trip_earning_net_pence?: number | null;
  actual_settlement_corrections_pence?: number | null;
  actual_tip_credit_pence?: number | null;
  capture_breakdown?: LegacyFrTripRow['capture_breakdown'] & {
    airport_charge_pence?: number | null;
    tip_pence?: number | null;
  } | null;
};

/** Mirrors FR drawer Expected entitlement display resolution. */
function resolveExpectedDisplay(row: NewFrTripRow) {
  return {
    fareNet: formatStoredPenceOrUnknown(row.expected_fare_net_pence ?? row.driver_net_pence),
    airport: formatStoredPenceOrUnknown(
      row.expected_airport_component_pence ?? row.airport_charge_pence,
    ),
    tip: formatStoredPenceOrUnknown(row.expected_tip_component_pence ?? row.tip_pence),
  };
}

/** Mirrors Payment Session evidence ONECAB breakdown resolution. */
function resolvePaymentSessionBreakdown(row: {
  fare_pence?: number | null;
  customer_payable_pence?: number | null;
  airport_charge_pence?: number | null;
  tip_pence?: number | null;
  authorised_amount_pence?: number | null;
  captured_amount_pence?: number | null;
}) {
  const airportLabel =
    row.airport_charge_pence == null
      ? 'Unknown'
      : isPositiveStoredPence(row.airport_charge_pence)
        ? formatStoredPenceOrUnknown(row.airport_charge_pence)
        : '—';
  const tipLabel =
    row.tip_pence == null
      ? 'Unknown'
      : isPositiveStoredPence(row.tip_pence)
        ? formatStoredPenceOrUnknown(row.tip_pence)
        : '—';
  return {
    fare: formatStoredPenceOrUnknown(row.fare_pence ?? row.customer_payable_pence),
    airport: airportLabel,
    tip: tipLabel,
    authorised: formatStoredPenceOrUnknown(row.authorised_amount_pence),
    captured: formatStoredPenceOrUnknown(row.captured_amount_pence),
  };
}

/** Mirrors Trip History list chip builder inputs from a trip-like row. */
function tripHistoryChipsFromRow(row: {
  tip_pence?: number | null;
  tip_amount_pence?: number | null;
  airport_charge_pence?: number | null;
}) {
  return buildTipAirportChips({
    tipPence: resolveTripTipPence(row),
    airportPence: resolveTripAirportPence(row),
  });
}

describe('FRONTEND_BACKWARD_COMPATIBLE_WITH_LIVE_EDGES', () => {
  it('A. legacy FR Edge row (no component fields) does not invent £0.00', () => {
    const legacy: LegacyFrTripRow = {
      trip_id: 'legacy-1',
      driver_net_pence: 425,
      captured_pence: 500,
      wallet_credit_pence: 425,
      expected_driver_credit_pence: 425,
      actual_driver_credit_pence: 425,
      credit_difference_pence: 0,
      driver_credit_health: 'OK',
      capture_breakdown: {
        ride_fare_pence: 500,
        pickup_waiting_charge_pence: 0,
        stop_waiting_charge_pence: 0,
        expected_capture_pence: 500,
        provider_captured_pence: 500,
        variance_pence: 0,
        variance_reason: null,
        capture_classification: 'MATCH',
      },
    };

    const display = resolveExpectedDisplay(legacy);
    expect(display.fareNet).toBe('£4.25');
    // Missing tip/airport stamps → Unknown (not £0.00)
    expect(display.airport).toBe(ADMIN_FARE_COMPONENT_UNKNOWN);
    expect(display.tip).toBe(ADMIN_FARE_COMPONENT_UNKNOWN);

    // Actual component fields absent → Unknown
    expect(formatStoredPenceOrUnknown(legacy.actual_trip_earning_net_pence)).toBe(
      ADMIN_FARE_COMPONENT_UNKNOWN,
    );
    expect(formatStoredPenceOrUnknown(legacy.actual_tip_credit_pence)).toBe(
      ADMIN_FARE_COMPONENT_UNKNOWN,
    );

    // Existing totals still readable
    expect(formatStoredPenceOrUnknown(legacy.captured_pence)).toBe('£5.00');
    expect(formatStoredPenceOrUnknown(legacy.wallet_credit_pence)).toBe('£4.25');
    expect(legacy.credit_difference_pence).toBe(0);

    // Legacy capture_breakdown without tip/airport — optional access safe
    const airportFromBreakdown = legacy.capture_breakdown
      && 'airport_charge_pence' in legacy.capture_breakdown
      ? (legacy.capture_breakdown as { airport_charge_pence?: number | null }).airport_charge_pence
      : undefined;
    expect(airportFromBreakdown).toBeUndefined();
    expect(isPositiveStoredPence(airportFromBreakdown)).toBe(false);
  });

  it('A. legacy Payment Session list row without tip/airport fields stays usable', () => {
    const livePs = {
      // pre-#38 Edge: no fare_pence / airport_charge_pence / tip_pence
      customer_payable_pence: 500,
      authorised_amount_pence: 800,
      captured_amount_pence: 500,
      refunded_amount_pence: null as number | null,
      released_amount_pence: null as number | null,
    };
    const view = resolvePaymentSessionBreakdown(livePs);
    expect(view.fare).toBe('£5.00');
    expect(view.airport).toBe('Unknown');
    expect(view.tip).toBe('Unknown');
    expect(view.authorised).toBe('£8.00');
    expect(view.captured).toBe('£5.00');
    // Must not fabricate zero chips
    expect(view.airport).not.toBe('£0.00');
    expect(view.tip).not.toBe('£0.00');
  });

  it('A. Trip History with only tip/airport absent omits chips; totals unchanged', () => {
    const chips = tripHistoryChipsFromRow({
      tip_pence: null,
      tip_amount_pence: null,
      airport_charge_pence: null,
    });
    expect(chips).toEqual([]);
    // Fare/net totals are separate SSOT fields — chip omission must not invent components
    expect(sumKnownEntitlementComponentsPence({
      fareNetPence: 425,
      airportPence: null,
      tipPence: null,
    })).toBeNull();
  });

  it('B. new #38 Edge shapes render tip/airport without double-counting into chips', () => {
    const neu: NewFrTripRow = {
      trip_id: 'new-1',
      driver_net_pence: 1350, // airport already folded into net by fare SSOT
      captured_pence: 1600,
      wallet_credit_pence: 1450,
      tip_pence: 100,
      airport_charge_pence: 500,
      expected_fare_net_pence: 1350,
      expected_airport_component_pence: 500,
      expected_tip_component_pence: 100,
      actual_trip_earning_net_pence: 1350,
      actual_settlement_corrections_pence: 0,
      actual_tip_credit_pence: 100,
      expected_driver_credit_pence: 1450,
      actual_driver_credit_pence: 1450,
      credit_difference_pence: 0,
      capture_breakdown: {
        ride_fare_pence: 1000,
        pickup_waiting_charge_pence: 0,
        stop_waiting_charge_pence: 0,
        airport_charge_pence: 500,
        tip_pence: 100,
        expected_capture_pence: 1600,
        provider_captured_pence: 1600,
        variance_pence: 0,
        variance_reason: null,
        capture_classification: 'MATCH',
      },
    };

    const display = resolveExpectedDisplay(neu);
    expect(display.fareNet).toBe('£13.50');
    expect(display.airport).toBe('£5.00');
    expect(display.tip).toBe('£1.00');

    const chips = tripHistoryChipsFromRow(neu);
    expect(chips.map((c) => c.key)).toEqual(['airport', 'tip']);
    // Chips are labels only — entitlement sum for display requires explicit components;
    // do not add airport again onto driver_net for chip purposes.
    expect(chips).toHaveLength(2);

    expect(formatStoredPenceOrUnknown(neu.actual_trip_earning_net_pence)).toBe('£13.50');
    expect(formatStoredPenceOrUnknown(neu.actual_tip_credit_pence)).toBe('£1.00');
    expect(storedPenceDifference(
      neu.actual_driver_credit_pence,
      neu.expected_driver_credit_pence,
    )).toBe(0);
  });

  it('C. missing/null legacy fields → Unknown or omit; zero present stays £0.00 only when stored', () => {
    expect(formatStoredPenceOrUnknown(null)).toBe(ADMIN_FARE_COMPONENT_UNKNOWN);
    expect(formatStoredPenceOrUnknown(undefined)).toBe(ADMIN_FARE_COMPONENT_UNKNOWN);
    expect(formatStoredPenceOrUnknown(0)).toBe('£0.00');

    const psZeroAirport = resolvePaymentSessionBreakdown({
      fare_pence: 500,
      airport_charge_pence: 0,
      tip_pence: 0,
      captured_amount_pence: 500,
    });
    // Present zero → em dash (not chip / not Unknown-as-money)
    expect(psZeroAirport.airport).toBe('—');
    expect(psZeroAirport.tip).toBe('—');

    const chips = buildTipAirportChips({ tipPence: 0, airportPence: 0 });
    expect(chips).toEqual([]);
  });

  it('C. Wallet settlement/payout rows without tip/airport remain usable', () => {
    const legacySettlement = {
      driver_net_pence: 425,
      wallet_credit_pence: 425,
      tip_pence: null as number | null,
      airport_charge_pence: null as number | null,
    };
    expect(formatStoredPenceOrUnknown(legacySettlement.driver_net_pence)).toBe('£4.25');
    expect(
      legacySettlement.airport_charge_pence == null
        ? 'Unknown'
        : formatStoredPenceOrUnknown(legacySettlement.airport_charge_pence),
    ).toBe('Unknown');
    expect(
      legacySettlement.tip_pence == null
        ? 'Unknown'
        : formatStoredPenceOrUnknown(legacySettlement.tip_pence),
    ).toBe('Unknown');
    // No double-count path: airport breakdown only when positive
    expect(isPositiveStoredPence(legacySettlement.airport_charge_pence)).toBe(false);
  });
});
