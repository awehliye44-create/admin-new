
# Pricing System Repair Plan

Before any code changes I need to flag four conflicts between your spec and the current database, because picking the wrong path will break trips, settlements, and the offer flow.

## What's actually there today

There are **two pricing tables** running in parallel, which is the root cause of "vehicle pricing fields disappeared":

| Table | What it has | Who reads it |
|---|---|---|
| `service_area_vehicle_pricing` (SOT per memory) | per vehicle: `base_fare`, `minimum_fare`, `distance_pricing` (jsonb tiers), `time_pricing` (jsonb tiers), `commission_percentage`, `offer_settings` (jsonb) | Admin UI only |
| `fare_pricing_settings` | flat: `base_fare_pence`, `per_km_rate_pence`, `per_min_rate_pence`, `minimum_fare_pence`, plus dynamic-pricing, waiting, cancellation, no-show, late-cancel fields | The fare engine (`estimate-fare`) |

The engine ignores `service_area_vehicle_pricing` rate fields entirely. That's why the "Vehicle Types for this Service Area" tab looks broken: the admin form edits one table, the engine quotes from another.

## Conflicts in your spec vs. reality

1. **`perMileRate`** — DB stores per-km, not per-mile. Region has `distance_unit`. I'll display in the region's unit but store km internally (no schema rename).
2. **`pickup_fee` / `dropoff_fee`** — those columns don't exist. `custom_zones.airport_fee` exists but is unused. `zone_route_pricing.airport_charge` exists and is in use today.
3. **`pickupZone.is_airport` / `pickupZone.type === "airport"`** — `custom_zones` has `zone_type` (text) but no `is_airport` boolean. I'll detect airports by `zone_type ILIKE 'airport'` OR `airport_fee > 0`.
4. **Chip presets** — current model is PERCENT (`presets: [{value:10},{value:15},{value:20}]` = +10%/+15%/+20% of fare). Your spec wants flat-increment chips (`+0.50`, `+0.70`, `+0.90`). This is a behavior change, not a bug fix.

## Proposed work

### Phase A — Make `service_area_vehicle_pricing` the real SOT (db)
- Add flat columns to `service_area_vehicle_pricing`: `per_km_rate_pence`, `per_min_rate_pence` (computed from existing `distance_pricing[0].rate` and `time_pricing[0].rate` on migration so no data loss).
- Backfill `fare_pricing_settings.{base_fare_pence, per_km_rate_pence, per_min_rate_pence, minimum_fare_pence}` so per-vehicle rows match `service_area_vehicle_pricing`.
- Add trigger: writes to `service_area_vehicle_pricing` mirror the four rate fields into `fare_pricing_settings` (vehicle-scoped row, auto-created). This keeps the engine working while admin edits one table.

### Phase B — Admin "Vehicle Types for this Service Area" tab
Restore the per-vehicle pricing card with these editable fields, sourced from `service_area_vehicle_pricing`:
- Base fare, Per km rate (label "per mile" if region distance_unit=mi), Per minute rate, Minimum fare, Active toggle.
- Show all assigned vehicle types (do not hide when airport charge changes).

### Phase C — Separate airport charge for normal bookings
- Add `airport_charge_pence` to `service_area_vehicle_pricing` (per vehicle) — admin sets it once per vehicle.
- In `estimate-fare`, after meter calculation: detect airport via pickup/dropoff zone `zone_type='airport'`; if true, add `airport_charge_pence` as a separate line. Never folded into base_fare.

### Phase D — Route pricing keeps its airport charge separate
- Stop bundling `airport_charge` inside `quoted_fare_pence` in `applyZoneRoutePricing`. Return base + airport as two fields; `estimate-fare` returns them as separate `fareDetails` lines and a `totalFare`.

### Phase E — API response shape
`estimate-fare` returns per vehicle:
```
{
  pricingMode: "NORMAL_DISTANCE_TIME" | "ROUTE_PRICING",
  baseFarePence, airportChargePence, totalFarePence,
  driverKeepPence, driverTierCommissionPercent,
  chipsPence: [...],
  fareDetails: [{label, amountPence}, ...]  // airport row only if > 0
}
```

### Phase F — Driver-keep & commission
- Commission % from driver tier (already snapshotted on trip). For the estimate, use the vehicle's `commission_percentage`.
- `driverKeep = (baseFare - baseFare * pct/100) + airportCharge`. Airport charge is never commissioned. This matches the locked `tripAccounting` invariants for **estimates only**; settlement still goes through `tripAccounting.ts` unchanged.

### Phase G — Chip presets (flat increments)
- Extend `offer_settings.presets[].value` semantics with `presetType: 'FLAT' | 'PERCENT'` (already exists). When `presetType='FLAT'`, treat value as currency units added to `totalFare`.
- Admin UI: allow choosing FLAT and entering 0.50 / 0.70 / 0.90.
- `estimate-fare` computes `chipsPence` from `totalFare` (never `driverKeep`, never double-airport).

## What I will NOT touch
- `tripAccounting.ts` (locked invariants — settlement math stays as-is).
- Driver mobile app "You keep" display string — not in this repo. I'll fix the API; the driver app already reads `driverKeep`.
- Existing `fare_pricing_settings` columns — kept for waiting/cancellation/no-show config.
- Stacked/Scheduled dispatch (Phase 2/3 work from earlier).

## Open decisions I need from you

1. **Airport charge per vehicle vs. per service area?** Spec says `airportChargeFromAdmin` (one value). I propose **per-vehicle** so XL/Premium can charge more — agree, or one flat value for the whole service area?
2. **Chip presets — keep PERCENT option or fully replace with FLAT?** Your example uses FLAT; some operators may want PERCENT. I propose keeping both with a toggle. OK?
3. **Miles vs km labels** — keep storage in km, label as mi/km from region setting. OK?
4. **Migrating existing route-pricing rows** — today the airport charge is folded into `quoted_fare`; after this change the rider's total is unchanged but the breakdown changes. OK to ship as-is, or do you want me to ALSO split historical rows visually (no money change)?

I'll start coding the moment you confirm those four decisions (or say "use your defaults").
