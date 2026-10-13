# Production Edge Functions snapshot — 2026-10-02

Read-only capture of every deployed Edge Function in Supabase project `thazislrdkjpvvghtvzo` (315 functions).
Not a deploy source. Each function is stored with its own bundle under `functions/<slug>/`, because live
functions were deployed at different times with different `_shared` / `shared` versions.

- `MANIFEST.tsv` — live version, verify_jwt, updated_at per function
- `DIFF_VS_MAIN_2e54510e.tsv` — per-function file comparison against origin/main @ 2e54510e
  (IDENTICAL 182, DRIFT 128, ABSENT_FROM_MAIN 5)

Captured 2026-10-02 via `supabase functions download --use-api`; five bundles whose repo-root `shared/`
files could not be extracted by the CLI (admin-remediate-trip-payment, auto-dispatch, finalize-trip-and-capture,
guest-trip-status, stop-workflow) were captured from the Management API file listing instead.

## 2026-10-13 partial refresh — payout recovery deploy

Six functions were re-captured from production after the payout recovery deploy
(source: branch `release/payout-recovery-prod-lineage`, runbook
`docs/deploy/PAYOUT_RECOVERY_20261013.md` there). Every other function in this
snapshot is still the 2026-10-02 capture and may have been redeployed since.

| Function | Live version |
|---|---|
| cancel-trip | v714 |
| driver-withdraw | v109 |
| reconcile-submitted-driver-withdrawals | v79 (import map `supabase/functions/deno.json`) |
| admin-execute-weekly-payout-occurrence | v127 |
| admin-weekly-payout-scheduler | v219 |
| admin-finance-reconciliation | v292 |

Captured 2026-10-13 via the Management API file listing (`get_edge_function`),
byte-for-byte; MANIFEST.tsv rows updated for these six only.
