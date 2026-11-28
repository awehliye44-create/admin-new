/** Offline test/audit-only helpers; not part of Edge uploads. */


/** Golden fixtures for accepted money truth (Slice 4 acceptance). */
export const CANONICAL_SETTLEMENT_GOLDEN_TRIPS = [
  {
    trip_code: "MK-260708-007",
    ride_fare_pence: 480,
    pickup_waiting_charge_pence: 0,
    stop_waiting_charge_pence: 0,
    airport_charge_pence: 0,
    tip_pence: 0,
    commission_percent: 15,
    provider_processing_fee_pence: 25,
    expected: {
      captured_pence: 480,
      commissionable_fare_pence: 480,
      onecab_gross_commission_pence: 72,
      driver_net_pence: 408,
      onecab_net_commission_pence: 47,
    },
  },
  {
    trip_code: "MK-260708-008",
    /** Base ride + waiting inside commissionable (680 + 18). */
    ride_fare_pence: 680,
    pickup_waiting_charge_pence: 18,
    stop_waiting_charge_pence: 0,
    airport_charge_pence: 0,
    tip_pence: 0,
    commission_percent: 15,
    provider_processing_fee_pence: 27,
    expected: {
      captured_pence: 698,
      commissionable_fare_pence: 698,
      onecab_gross_commission_pence: 105,
      driver_net_pence: 593,
      onecab_net_commission_pence: 78,
    },
  },
  {
    trip_code: "MK-260709-010",
    ride_fare_pence: 480,
    pickup_waiting_charge_pence: 0,
    stop_waiting_charge_pence: 0,
    airport_charge_pence: 0,
    tip_pence: 0,
    commission_percent: 15,
    provider_processing_fee_pence: 25,
    expected: {
      captured_pence: 480,
      commissionable_fare_pence: 480,
      onecab_gross_commission_pence: 72,
      driver_net_pence: 408,
      onecab_net_commission_pence: 47,
    },
  },
] as const;


/** Phase 0b golden fixtures — promotion + terminal + extras. */
export const AUTHORITATIVE_SETTLEMENT_GOLDEN_FIXTURES = [
  { label: "no_promotion", input: { ride_fare_pence: 480, commission_percent: 15, provider_processing_fee_pence: 25, fee_confirmed: true }, expected: { captured: 480, entitlement: 408, commission: 72, subsidy: 0 } },
  { label: "fixed_promotion", input: { pre_promotion_commissionable_fare_pence: 800, locked_promotion_pence: 100, commission_percent: 15, airport_charge_pence: 0, tip_pence: 0 }, expected: { captured: 800, entitlement: 680, commission: 120, subsidy: 100 } },
  { label: "percentage_promotion_global_offer", input: { pre_promotion_commissionable_fare_pence: 1000, locked_promotion_pence: 150, commission_percent: 15 }, expected: { entitlement: 850, commission: 150, subsidy: 150 } },
  { label: "promotion_cap", input: { pre_promotion_commissionable_fare_pence: 500, locked_promotion_pence: 200, commission_percent: 10 }, expected: { entitlement: 450, commission: 50, subsidy: 200 } },
  { label: "airport_fee", input: { ride_fare_pence: 600, airport_charge_pence: 500, commission_percent: 15 }, expected: { captured: 1100, entitlement: 510, commission: 90, extras: 500 } },
  { label: "tip", input: { ride_fare_pence: 400, tip_pence: 200, commission_percent: 15 }, expected: { captured: 600, entitlement: 340, commission: 60, extras: 200 } },
  { label: "dynamic_dispatch_commission", input: { ride_fare_pence: 700, commission_percent: 22 }, expected: { entitlement: 546, commission: 154 } },
  { label: "terminal_fee_zero_commission", input: { ride_fare_pence: 400, commission_percent: 0, provider_processing_fee_pence: 24, fee_confirmed: true, financial_outcome: "NO_SHOW" }, expected: { captured: 400, entitlement: 400, commission: 0, provider_fee: 24 } },
] as const;

export * from "../../../functions/_shared/canonicalSettlementSSOT.ts";
