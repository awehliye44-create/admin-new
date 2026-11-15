# Bug #25 — Customer trip modification payment decline recovery

**Date:** 2026-11-15  
**Scope:** Customer-only (backend already isolates rejected modifications).  
**Customer commit:** `6af35fcee885789bd8f4c90a57354dbcf90565b7`  
**Production deploy:** **PAUSED** (OTA / Edge / native / store) until approved.

## Exact root cause

`ReviewTripChangesScreen.onConfirm` showed the correct bank-decline alert (`Payment declined by your bank`) but the OK button had **no `onPress`**. After dismiss:

1. Local `useTripEditDraftStore` draft still held the rejected destination/stops.
2. Navigation stayed on Review (with Edit Trip under the stack).
3. Authoritative `activeTrip` / backend trip row were already unchanged.

Rejected modifications were **only retained in the Customer editing draft**, not leaked into confirmed trip data, route, or Driver state.

## Authoritative backend state

Backend payment-first SSOT (`MODIFICATION_REQUESTED → PAYMENT_PENDING → PROVIDER_CONFIRMED → MODIFICATION_APPLIED`) already keeps original destination/stops/route/fare on decline/fail/timeout (`revolut-incremental-auth-primary-lock`, `tripModificationPaymentGateSSOT`). No backend code change required.

## Before / after workflow

| Step | Before | After |
| --- | --- | --- |
| Bank decline popup | Correct copy | Unchanged |
| OK tap | Alert dismiss only | `clearDraft()` + `returnToCustomerAssignedTrip` |
| Addresses on screen | Rejected draft still shown | Active trip card with confirmed addresses |
| Reopen Edit Trip | Could reopen into same dirty draft if still mounted | `beginEdit(activeTrip)` from confirmed baseline |
| Driver | No apply on decline | Unchanged — no rejected-mod notify |

## Draft cleanup / navigation safeguards

- `paymentFailureResult` stamps `paymentUiState`.
- `shouldDiscardTripModificationDraftOnPaymentFailure` gates recovery (bank decline + pending/ambiguous/technical payment outcomes).
- `generationRef` ignores stale preview/submit after discard.
- Success path unchanged: `markSubmitSuccess` + `clearStops` + `returnToCustomerAssignedTrip`.

## Payment-first enforcement evidence

- Customer still never primary-invokes `confirm-trip-modification-payment` (MK-260916-030).
- Preview/submit remain isolated in draft store until applied status + restore.
- Decline OK does not mutate `activeTripStore` addresses/fare.

## Customer / Driver consistency

- Customer Assigned card continues to render live `activeTrip` (confirmed).
- Driver receives no route/earnings update for rejected mods (backend never applies).

## Changed files (Customer)

- `src/features/booking/screens/ReviewTripChangesScreen.tsx`
- `src/features/booking/data/tripModificationUi.ts`
- `src/features/booking/data/tripModificationAdapter.ts`
- `src/features/booking/data/tripEditTypes.ts`
- `src/features/booking/data/tripModificationUi.test.ts`
- `src/features/booking/lib/tripModificationPaymentDeclineRecoveryLock.test.ts`
- `src/features/booking/lib/tripModificationPaymentDeclineRecovery.execution.test.ts`
- `src/features/payments/unifiedBankDeclineCopy.lock.test.ts`
- `.cursor/rules/trip-mod-payment-decline-recovery-lock.mdc`

## Execution regressions (code-level)

Lock + execution + unified bank-decline + related flash/stop-removal locks: **PASS** (local jest).  
Device/simulator / paid bookings: **not run** (per brief).

## Deployment scope (when approved)

- Customer production OTA only (JS).
- No Edge / migration / Driver OTA / native rebuild required for Bug #25.

## Rollback

- Customer OTA rollback to prior production group (`194a3a5` baseline before this fix).
- No backend rollback needed.
