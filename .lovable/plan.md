# Make the tested payment correction deployable

The payment correction passes 65 targeted checks, but Supabase refused all seven attempted uploads because their source is too large. No live payment was changed.

## Proposed work

1. Reduce what each payment function uploads without changing fares, permissions, settings, payout rules or stored records.
2. Keep one shared payment implementation; do not create copied or fallback payment logic.
3. Run the same 65 checks and the affected packaging checks before deployment.
4. Deploy only the affected payment entry points, confirm that they start correctly, then close the monitoring finding.

## Technical details

- Supabase uploads every shared helper; the available guidance provides no dependency-only upload or exclusion mechanism. Reduce the source/dependency footprint using supported source restructuring, not an upload-limit bypass.
- Move exclusive helpers and tests first, then measure the remaining gap. Where still necessary, isolate bulky, unrelated operations into their own narrowly scoped functions so they no longer inflate every payment upload; document the resulting boundaries in `AGENTS.md`.
- Move test-only and single-function helpers to their existing appropriate directories only where needed; update all references and keep one implementation.
- Do not remove financial safeguards or strip source comments merely to evade the size cap. Do not deploy all project functions.
- Keep all current settled records unchanged. Do not initiate a real customer charge or create production test accounts.

## Completion evidence

- Every targeted upload is below the effective size limit and accepted by Supabase.
- Focused tests remain green, startup checks succeed, and preview reports no errors.
- State explicitly that a real bank-decline/payment flow remains unverified unless an authorised test environment is available.