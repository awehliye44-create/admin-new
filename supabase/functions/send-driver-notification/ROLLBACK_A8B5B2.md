# Phase A8B5B2 rollback levels

## Level A — Edge rollback (ordinary delivery failure)

1. Redeploy `send-driver-notification` **v513** (pre-gate; `verify_jwt=false`).
2. **Leave** SQL Vault bridge installed (`onecab_internal_notification_http_headers` + Vault-header callers).
3. **Retain** Vault secret `onecab_internal_notification_token`.
4. **Retain** Edge secret `ONECAB_INTERNAL_NOTIFICATION_TOKEN`.

This restores public endpoint availability without breaking SQL notifications:
- v513 ignores the internal header (still delivers).
- Future strict Edge requires the internal header or exact service-role Bearer.

Do **not** run the SQL rollback file for Level A.

## Level B — Full database rollback (business/payload only)

Use `supabase/migrations/rollback/rollback_20261109170000_phase_a8b5b2_sql_internal_notification_vault_bridge.sql` only if caller **business/payload/error** bodies must be re-asserted.

- Continues using Vault internal header helper.
- Does **not** restore embedded anon JWTs.
- Does **not** authenticate SDN via cron edge helpers or empty GUCs.
- Does **not** drop the Vault helper while SQL callers depend on it.

## Secrets

Secret deletion is **last**, only after every SQL caller has migrated away from the bridge.
