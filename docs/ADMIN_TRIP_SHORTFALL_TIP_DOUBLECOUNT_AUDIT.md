# Trip History shortfall tip double-count — audit

Base: `2b65a809` · Branch: `fix/admin-trip-shortfall-tip-doublecount-20260916`

## Defective formula (proven)

```
Edge customer_payable_pence = final_customer_fare (500) + tip (100) = 600
→ frontend stuffs 600 into trip.final_customer_fare_pence
→ resolveTripHistoryCustomerPayablePence adds tip again
→ 600 + 100 = 700
→ shortfall = max(0, 700 − 600) = 100
→ Recapture £1.00
```

Owning files:
1. `src/components/trips/TripHistoryShortfallRecaptureAction.tsx` — overwrites `final_customer_fare_pence` with tip-inclusive Edge payable
2. `supabase/functions/_shared/tripHistoryPaymentLayersSSOT.ts` → `resolveTripHistoryCustomerPayablePence` — adds tip when `source` starts with `final`

## Field lineage

| # | Display | DB / API | Edge mapper | Frontend | Display helper |
|---|---|---|---|---|---|
| 1 | Final customer payable (Trip Fare) | `trips.final_customer_fare_pence` + `tip_pence` | (client-only) `buildTripHistoryPaymentEvidenceReadModel` → `resolveTripHistoryCustomerPayablePence` | `getTripCustomerPayablePence` | `/100` + currency |
| 2 | Customer Payment → Fare | `final_customer_fare_pence` | — | `buildCanonicalTripEconomicsRead` | `formatStoredPenceOrUnknown` |
| 3 | Tip | `tip_pence` / `tip_amount_pence` | — | `resolveTripTipPence` | `formatStoredPenceOrUnknown` |
| 4 | Total paid | PS `captured_amount_pence` | disposition / evidence | `getTripProviderCapturedPence` | `formatStoredPenceOrUnknown` |
| 5 | Shortfall → Customer payable | **buggy path** above | `admin-get-trip-payment-state` `customer_payable_pence` | ShortfallAction evidence rebuild | currency format |
| 6 | Verified captured | PS confirmed captures | `sumVerifiedCaptured` / layers | evidence `verified_captured_pence` | currency |
| 7 | Outstanding shortfall | payable − net captured | `computeOutstandingShortfallPence` | gate + evidence | currency |
| 8 | Recapture amount | same shortfall | server recomputes (must use tip-once payable) | `recaptureActionLabel` | label |
| 9 | Refunded | PS `refunded_amount_pence` | disposition | `getTripProviderRefundedPence` → null | was `Unknown` |
| 10 | Actual wallet credit | ledger TEN+TIP | not wired | hardcoded `null` | was `Unknown` |

## Mapping gaps

- **Refunded Unknown**: disposition/PS refund field absent → null; UI must say **Unavailable** (evidence not loaded), not invent £0.
- **Actual wallet credit Unknown**: Trip History never passes ledger actual (`actualWalletCreditPence: null`); show **Unavailable — wallet credit not loaded on this panel**.

## Correct rule

One basis only: tip-exclusive `final_*` + tip once, **or** authoritative tip-inclusive Edge payable — never both.
Shortfall = `max(0, canonical_payable − verified_net_captured)`.
