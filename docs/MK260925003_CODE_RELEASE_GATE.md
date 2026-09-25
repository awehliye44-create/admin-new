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

## Deploy package table (frozen tip `3a5dc643`)

Unresolved=0 for all. Rollback = redeploy current live ezbr (do not invent prior).

| Slug | Live ver | Rollback ezbr (full) | Files | Tip package SHA-256 (full) | Changed modules in package |
|------|----------|----------------------|------:|----------------------------|----------------------------|
| finalize-trip-and-capture | 538 | `533ec29ef12e7c5320f2f3ef3b2ca4f89cf28b62fe8e9bbd36a0346f983762b4` | 76 | `2642b68a1f6432f1bcb53353f20d45590b4c79e43f3ddda3f226677a0d4809f4` | localApply, revolutCompletion, paymentSession, tripSettlement, applyCanonical |
| admin-capture-trip-payment | 311 | `2ac338373064a0a6f0934473b7b3c1da9a3c208752bcd9204a9b8a41a188f6d0` | 75 | `f275e87e6cd67ace15fbe38a7c532bc8c6eccad1a59f697a811210cbd48a83bf` | adminCapture, applyCanonical, paymentSession, tripSettlement |
| admin-remediate-trip-payment | 124 | `9a3f297dd78fb34f3656306917ad87293df6143aef985c9185f44bcde25e16c4` | 81 | `4409c558acb1cf265ff119526a96aeed1c1f6855eaba897b2414d2648b96f59e` | localApply, revolutCompletion, paymentSession, tripSettlement, applyCanonical |
| capture-expired-tip-windows | 170 | `d3dbc15fc6d8c8d43f6ff299f74f138987f13333b783af7e4541ea1c6ef0c6db` | 40 | `663c864509a753d4548817aa6ea518bd840e15f8cc574ff79809b64dee76216a` | tripSettlement |
| sweep-revolut-stale-holds | 179 | `61fc01ad97bb92f163c08ba2b9f607357409deb2bec6f9c407bd8b87bad1aaf2` | 57 | `455d3e296dcadf159fc947b27161f867d7b01c2bd7b29168aab16b2f132b6175` | applyCanonical, paymentSession, tripSettlement |
| stop-workflow | 654 | `9b3b0792218538218da2cead2f54e2b316f389ecdc429b6836a2b6eec1a42ff2` | 91 | `d34fa60cc85577679509fe067adec9d652391b88949a4d149f7724d992a2069a` | paymentSession, tripSettlement |
| revolut-webhook | 300 | `ca0a461665c700ca8c8649c48acfa321db328177d529c5138318f165efa56d83` | 52 | `ca093f93531015525b6712d9fbe278a008564f4cb0e61f78eda88db2fd60d71a` | paymentSession, tripSettlement |
| admin-hold-action | 139 | `c430438adf43af8372448ff099f3d332e38fe9fac15514913091739ecd584109` | 53 | `64b8fdf56735d6f2e9ed41742c0f09edc81918fdddfe480be30d2475a4ae6f2a` | paymentSession, tripSettlement |

Do **not** assume deploying finalize updates webhook/admin/sweep bundles — deploy each package listed.

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
