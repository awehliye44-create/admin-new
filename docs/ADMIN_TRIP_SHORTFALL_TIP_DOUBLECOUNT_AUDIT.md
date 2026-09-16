# Trip History shortfall tip double-count — audit

Base: `2b65a809` · Branch: `fix/admin-trip-shortfall-tip-doublecount-20260916`
Fixture: **MK-260912-005** (fare 500 + tip 100 + airport 0 → payable 600 / captured 600 / shortfall 0)

## Defective formula (proven)

```
Edge customer_payable_pence = final_customer_fare (500) + tip (100) = 600
→ frontend / payment-state stuffed 600 into final_customer_fare_pence
→ resolveTripHistoryCustomerPayablePence added tip again
→ 600 + 100 = 700
→ shortfall = max(0, 700 − 600) = 100
→ false Recapture £1.00
```

Also: `admin-get-trip-payment-state` returned `final_customer_fare_pence: customer_payable` (tip-inclusive stuffed into fare-only field).

## Corrected formula

```
authoritative_customer_payable =
  customer_payable_pence                         # aggregate path (once)
  OR tip_exclusive_final + tip_pence             # component path (once)
  NEVER both

verified_net_captured = confirmed_captured − confirmed_refunded
outstanding_shortfall = max(0, authoritative_customer_payable − verified_net_captured)
```

Unknown fold semantics → fail closed (payable/shortfall unavailable, Recapture hidden).
No numeric “tip already folded” heuristic.

## Field lineage (after)

| Field | Contract | Owner |
|---|---|---|
| `final_customer_fare_pence` | tip-exclusive fare stamp | trips + payment-state (never stuffed) |
| `customer_payable_pence` | tip-inclusive authoritative aggregate | layers / payment-state / ShortfallAction |
| `customer_payable_source` / `payable_source` | provenance enum | `customerShortfallEvidenceSSOT` |
| tip / airport | display components only when aggregate used | UI breakdown |
| verified captured / refunded | confirmed sessions only | `tripHistoryShortfallRecaptureSSOT` |
| outstanding shortfall | SSOT formula above | shared evidence + `admin-recapture-trip-shortfall` |

## Shared SSOT

`supabase/functions/_shared/customerShortfallEvidenceSSOT.ts`
(re-exported via `shared/customerShortfallEvidenceSSOT.ts`)

Used by:
- Trip History payment evidence read model
- Trip History payment layers payable resolution
- `admin-recapture-trip-shortfall` (server recomputes; client amount is stale witness only)
- Recapture eligibility / provider-call boundary (`allow_provider_call`)

## Mapping gaps (UI)

- **Refunded**: £0.00 only when confirmed zero; else `Unavailable — Payment Session refund evidence not loaded.`
- **Actual wallet credit**: value only when ledger loaded; else `Unavailable — Wallet ledger credit not loaded on this panel.`
- Zero shortfall → no “Customer payment shortfall” panel / Recapture button.
