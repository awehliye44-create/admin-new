# PR #80 — Migration filename alignment (source hygiene)

## Collision

`20260925120000` was already live as `negotiation_decision_hold_sql_timeout`.
Capture-composition DDL was applied from tip `18a71216…` and registered as:

- `20261130120000` / `capture_composition_components`
- `20261130130000` / `payment_session_acquire_capture_composition`

## Canonical source (this PR)

- `supabase/migrations/20261130120000_capture_composition_components.sql`
- `supabase/migrations/20261130130000_payment_session_acquire_capture_composition.sql`
- matching `rollback/rollback_2026113012…` / `rollback_2026113013…`

## Forward content SHA-256 (unchanged)

- components: `323d723737c65692fb697b1e87505b19f53e71f16281fd989ad9cf607c6e28b2`
- atomic RPC: `761c235e24fed675d994a69645bf18e7d244955ecc69b9fe6de5caca6baa6438`

Forward file bodies were renamed only (no SQL behaviour change). In-file header
comments may still mention pre-rename rollback paths to keep those hashes stable.

## Hard stop

No re-apply, no history edit, no Edge redeploy, fold remains OFF.
