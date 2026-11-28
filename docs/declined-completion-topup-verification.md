# Declined completion top-up — verification

## Customer rule

When the bank declines an extra fare amount, collect no more than the confirmed existing hold, preserve the remaining amount owed, and continue the existing driver settlement flow. Airport fees, accepted fare changes, waiting and discounts must each affect the payable once. A changed fare, unconfirmed provider result, busy lock or inflight payment operation must still block unsafe collection.

## Confirmed and corrected

- Completion's fallback supplied the partial funded amount as the full payable basis. It now uses the full payable returned with the shared safe-capture decision; the amount sent to Revolut remains the smaller confirmed hold.
- The snapshot writer used a competing additive fare formula. It now uses the capture fare's shared component resolvers, including folded airport/modification/discount detection and stop-waiting fallback.
- Booking's committed-row projection now includes the airport split evidence needed by those resolvers.
- Recovery's trip projection retains the same evidence. Its reconstructed booking input labels the customer fare as net rather than labelling gross as net; this preserves its existing discount arithmetic.
- No existing paid, refunded or otherwise settled records were edited, and no live customer charge or test booking was initiated.

## Related paths read

| Path | Assessment |
| --- | --- |
| `revolutCompletionCapture.ts`: declined increment, both full capture paths, provider-already-captured branch | Corrected partial payable basis; both full captures retain the existing guard; settlement and shortfall recording already exist after confirmation. |
| `guardedProviderCaptureSSOT.ts` | Existing stale payable/version, session lock, financial claim, provider GET confirmation protections retained. |
| `finalizeRevolutTripCapture.ts`, `tipWindowImmediateFinalizeSSOT.ts` | Delegate to the same completion function. Tip-window deferral is unchanged. |
| Completion, stop workflow, tip submission/expiry, stale-hold sweep and admin-remediation entry points | Their capture call sites delegate to the shared completion function, directly or through the tip-window wrapper/HTTP finalizer. |
| `PaymentControlsCard.tsx`, `adminCaptureTripPaymentSSOT.ts` | Admin capture delegates to the guarded provider capture, with provider confirmation before local persistence; not the declined-completion fallback. Existing admin override behavior was not changed. |
| `terminalTripPaymentDisposition.ts`, `revolutPreauthReleaseSSOT.ts` | Cancellation/lifecycle fees are capped at authorisation and use non-fare purposes, so the reported fare-total comparison does not apply. No changes. |
| `revolut-webhook/index.ts` imports and payment capture inventory | Provider-event reconciliation is separate from the completion top-up POST. No direct competing capture POST was found by the capture-call inventory. |
| Booking post-commit snapshot, `accept-offer`, `customer-fare-decision`, `driver-fare-final` snapshot call sites | Use the shared writer; booking projection corrected. Negotiation uses committed customer payable. |
| `executeFareIncreaseModificationPayment.ts` snapshot call site | Writes the updated committed trip through the shared snapshot writer. |
| `platformCollectedFinancialIntegrityRecoverySSOT.ts` | Evidence-only recovery does not POST money; input/projection corrected for the shared resolver. No historical recovery was run. |
| `admin-trip-action` force-complete snapshot call site | Explicit admin override and included-waiting basis retained; outside the declined-increment path. |
| Migration capture-call inventory | No SQL provider capture POST implementation found; no migration needed. |

“Read” means the relevant source/call site was inspected, not that its authenticated live screen or background job was exercised. Driver/rider application screens are not in this repository.

## Verification

- 12 new Vitest regressions pass. Includes the real completion orchestrator and real capture guard with mocked bank/database boundaries: 875p payable, 788p held, top-up declined, one 788p capture, confirmed session marker, settlement invocation, 87p remaining debt.
- 53 existing Deno fare, payment safety, settlement, booking and recovery regressions pass.
- Preview telemetry reports `build OK` after the source edits.
- Project test wrapper failed to start (npm dependency-resolution error / isolated runner could not resolve jsdom); the installed project Vitest runner was used successfully instead.
- No authenticated live payment flow was run. Provider/database persistence boundaries in the new completion-flow test are mocked; this does not prove a real bank capture or live wallet entry.

## Deployment blocker

Deployment of `finalize-trip-and-capture`, `stop-workflow`, `submit-customer-trip-tip`, `capture-expired-tip-windows`, `sweep-revolut-stale-holds`, `admin-remediate-trip-payment` and `create-trip-after-payment` was attempted. Supabase refused every upload: approximately 4.7 MB for most and 4.9 MB for stop-workflow, versus the effective approximately 4.5 MB limit. Nothing was deployed by that attempt.

Shared source alone is 4,673,589 bytes. Moving every single-function helper and test-only file would remove only about 244 KB before accounting for the destination function's own upload, so that alone does not safely solve every affected upload. A broader packaging change needs review; no unrelated helpers were moved or deleted.

The monitoring finding remains open until deployment is completed and checked. The code correction is saved and tested, but must not be presented as live.