# Phase 1 — Capture persistence caller audit (MK-260925-003)

## Direct `markPaymentSessionCaptured` callers

| Caller | Terminal GET? | Passes providerEvidence? | Can process RESERVED recv? | Persist capture without local settle? | Could re-POST after LOCAL_APPLICATION_INCOMPLETE? |
|---|---|---|---|---|---|
| `revolutCompletionCapture` already_captured path | YES (retrieve before mark) | YES (inline COMPLETED) | YES via settle gate | NO after harden (recv>0 throws) | NO (`manual_review` / incomplete; GET-first) |
| `revolutCompletionCapture` safe-capture path | YES (post-capture GET) | YES (`buildProviderSettleEvidenceFromGet`) | YES | NO after harden | NO |
| `revolutCompletionCapture` reconciled/locked/unguarded paths | YES | YES (`buildProviderSettleEvidenceFromGet`) | YES | NO after harden | NO |
| `persistConfirmedProviderCapture` | YES (caller supplies provider payload/state) | YES (always CAPTURED + amountFromProviderGet) | YES | NO after harden if settle fails | NO (helper does not capture POST) |

## `persistConfirmedProviderCapture` callers

| Caller | Terminal GET? | Evidence | RESERVED | Persist w/o settle | Re-POST risk |
|---|---|---|---|---|---|
| `paymentHoldProviderTerminalSSOT` (CAPTURED) | YES (provider payload) | via persist helper | YES | fail-closed on settle fail | NO (terminal apply only) |
| `adminCaptureTripPaymentSSOT` | YES (retrieve/capture then persist) | via persist helper | YES | fail-closed | NO (financial lock; incomplete ≠ retry capture) |

## `applyCanonicalSettlementAfterCapture` callers

| Caller | Terminal GET? | Fare component | Notes |
|---|---|---|---|
| `revolutCompletionCapture.ensurePostCaptureSettlement` | after capture confirmed | YES (`tripFareComponentPence` from composition) | TEN/stamps from fare component |
| `adminCaptureTripPaymentSSOT` | after persist | YES (session composition) | recovery/fresh |
| `sweep-revolut-stale-holds` heal path | provider already captured | recovery mode (saved stamps) | does not POST capture |

## `revolutCompletionCapture` / `finalizeRevolutTripCapture` Edges

| Edge | Role |
|---|---|
| `finalize-trip-and-capture` | primary customer completion |
| `admin-remediate-trip-payment` | admin remediation via finalize |

## `resolveSettlementFinalFarePence`

| Caller | Notes |
|---|---|
| `calculateTripSettlementFromTripRow` | prefers `trip_fare_component_pence` when set |
| lock tests | certify contamination class A is fixed |

## Hard rule status

Planned receivable_component > 0 without `providerEvidence.amountFromProviderGet` →
`LOCAL_APPLICATION_INCOMPLETE:missing_provider_evidence_with_receivable` after durable capture persist.

Zero-receivable historical callers remain compatible (settle skipped / release path only when planned=0).

