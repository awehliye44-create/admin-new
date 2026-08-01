# Driver identity re-verification — backend ownership

**Project decision (2026-07-30):** For the identity re-verification feature, **`admin-new` is the authoritative backend workspace**.

## Why

`admin-new` currently holds the newest production-parity writers for the gates this feature must change, including:

- `supabase/migrations/20260904120000_driver_availability_intent_ssot.sql`
- `assert_driver_presence_online_eligible`
- presence / availability sync
- `find-drivers`
- `send-driver-notification`
- `auto-dispatch`

## Conflict recorded

Historical docs in `onecab-comfy-ride` still name `drive-hub-buddy` as the canonical deploy source for dispatch/trip Edges. That sibling is **not** available as a working tree on this machine, while `admin-new` contains **newer** eligibility/availability migrations than `onecab-comfy-ride`.

This identity implementation therefore authors migrations and Edge Functions **only** in `admin-new`.

## Hard rules

1. `admin-new` owns the production-parity migrations and Edge Functions modified by identity re-verification.
2. Identity migrations **must not** be duplicated into `onecab-comfy-ride`, `onecab-driver-native`, or `onecab-customer-native`.
3. Restoring `drive-hub-buddy` later requires a **deliberate reconciliation and ownership transfer**, not automatic copying of these files.
4. Newer migration timestamps and production parity must be preserved; do not re-apply older copies of `assert_driver_presence_online_eligible` over this work.

## Deploy note

Local authoring only until explicit deploy approval. Do not apply these migrations or deploy related Edge Functions without a separate release decision.
