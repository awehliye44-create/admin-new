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
