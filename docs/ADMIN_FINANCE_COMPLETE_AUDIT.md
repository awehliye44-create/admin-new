# Admin Finance Complete — Phase 1 audit (F1–F4)

Base: `a8cc8598` · Tree: `ee2031ca638bd3bcc3229de1e4b3b81cbe2e4b25`

## Audit table

| Screen/API | Expected basis | Actual basis | Current result | Correct result | Owning SSOT |
|---|---|---|---|---|---|
| FR trip audit (`financeSettlementSummary`) | Fare net (excl tip) + tip + airport components → entitlement | Trip-scoped TEN + DRIVER_TIP_CREDIT | expected display 525 but health uses 625 (entitlement as `driver_net` + tip again) → UNDER −100 | expected 525, actual 525, diff 0, OK | `classifyDriverCreditHealth` + `resolveFrDriverExpectedEntitlement` |
| Wallet settlement history (`fetchDriverWalletPayoutSnapshot`) | Same trip entitlement | Ledger by `related_trip_id` | Tip trip not in settlements → ledger not loaded for trip → false `MISSING_LEDGER_CREDIT` | Recognise TEN+TIP; no false missing | `buildPaymentSessionDriverCreditFields` + settlement history builder |
| FR `?driver_id=` | N/A (runtime) | `computeNextWeeklyPayoutRun` | `export { X } from` re-export — no local binding → ReferenceError | Import + call real `payoutScheduleSSOT` | `perDriverFinancialReconciliation.ts` |
| Wallet `wallet_status` / UI freeze banner | Credit variance vs payout eligibility (separate) | Mixed: `payout_blocked`/`payouts_enabled` forced FROZEN; dead OverviewCards + live ActivePosition conflated credit into status | MK0006 credit OK but FROZEN + mismatch copy | Credit OK; wallet RESTRICTED when payouts disabled; UI shows payout hold reason | `fetchDriverWalletPayoutSnapshot` + `driverWalletPayoutStatusDisplay` on live wallet surfaces |

## Field roles

| Field | Role |
|---|---|
| `driver_net_pence` (trip stamp) | Fare net component — excludes tip |
| `tip_pence` | Tip component |
| `airport_charge_pence` | Airport component (already in fare net when folded) |
| `expected_entitlement_pence` | Aggregate = fare net + tip (+ other pass-throughs per entitlement SSOT) |
| `actual_wallet_credit_pence` | Aggregate from trip-scoped TEN + DRIVER_TIP_CREDIT |
| `credit_difference_pence` | actual − expected |

## Callers of `classifyDriverCreditHealth`

1. `financeSettlementSummary.ts` — **bug**: passes `expectedDriverNet` (aggregate) as `driver_net_pence`
2. `buildPaymentSessionDriverCreditFields` → used by wallet settlement history (fare net correctly when trip stamp used)
3. Tests / audit scripts
