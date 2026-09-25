# MK-260925-003 — Code release gate (draft)

## Accepted findings

1. Provider captured 740p exactly once.
2. `markPaymentSessionCaptured` persisted without terminal GET `providerEvidence`.
3. `settleReceivablesFromProviderEvidence` never called.
4. `resolveSettlementFinalFarePence` preferred capture 740 over fare 704.
5. TEN 598 correct — preserve.
6. No provider / wallet / commission-ledger repair required.

## Containment

Fold OFF · Buffer OFF · Repairs not executed · Draft code only.

## Code changes

| File | Change |
|---|---|
| `captureCompositionLocalApplySSOT.ts` | NEW — composition read, fare stamps, evidence builder, state machine |
| `tripSettlement.ts` | Prefer `trip_fare_component_pence` for economic stamps |
| `applyCanonicalSettlementAfterCapture.ts` | Pass `tripFareComponentPence` |
| `paymentSessionSSOT.ts` | Fail closed if recv>0 without evidence; throw on settle fail after durable capture |
| `revolutCompletionCapture.ts` | Always pass GET `providerEvidence`; composition fare into settlement; MANUAL_REVIEW |
| `adminCaptureTripPaymentSSOT.ts` | Pass composition fare into settlement |
| Lock path hygiene | `revolutCompletionCaptureBootLock` / `sweepCompletedAuthorisedCaptureLock` assert real relative imports |

## Migration

**None required.** Existing `customer_receivable_settle_from_provider_capture` RPC + capture composition DDL already live (`2026113012/130000`).

## Tests

- New release locks: `captureCompositionLocalApplyLock.test.ts` — **20 passed**
- Prior financial suite (composition / settlement / receivable / capture locks): **200 passed / 0 failed**

## Deploy package table (frozen tip — fill SHA after commit)

See `/tmp/cu040-e2e/deploy_closure_table.json`. Rollback = current live ezbr.

## Release order

1. Review + merge this PR
2. Deploy exact affected Edge packages (do not assume finalize updates webhook)
3. Zero-money verification
4. STOP for Repair A
5. Repair A only
6. Verify outstanding clears
7. STOP for Repair B
8. Repair B only
9. Verify Driver Wallet diff clears without ledger mutation

## Repair previews

- Repair A: `/tmp/cu040-e2e/REPAIR_A_CERTIFICATION.md`
- Repair B: `/tmp/cu040-e2e/REPAIR_B_CERTIFICATION.md`
