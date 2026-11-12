# Phase 3 Final Security & Release Readiness

**Production deployment is NOT approved until explicit sign-off.**

## 1. Action-level RBAC

| Action | Permission key | Enforcement |
|---|---|---|
| Make Available Now/At | `scheduled_rides.make_available` | Edge `requireStaffAction` |
| Assign Now/At | `scheduled_rides.assign` | Edge + `admin_assign_scheduled_driver` |
| Broadcast Now/At | `scheduled_rides.broadcast` | Edge |
| Exceptional Hold | `scheduled_rides.hold` | Edge |
| Cancel Pending | `scheduled_rides.cancel_pending` | Edge |
| Cancel Ride | `scheduled_rides.cancel_ride` | Edge |

- Catalog: `shared/rolesPermissionsSSOT.ts` + Roles & Permissions UI matrix
- Backend authority: `public.staff_has_action` (Owner bypass; missing row = deny)
- Page access alone is insufficient
- **No mass-grant** of emergency actions in migration
- Inactive / suspended staff fail `requireAnyPageAccess` (`is_active=true`)
- Unauthenticated → 401; bare service-role JWT → `STAFF_JWT_REQUIRED`

## 2. Direct mutation protection

Migration `20270213130000_scheduled_marketplace_final_security.sql`:

- `admin_page_mutate` UPDATE on `trips` raises `42501` if patch touches protected fields
  (`scheduled_status`, `scheduled_broadcast_at`, `broadcast_enabled`, hold/pending/assign/dispatch fields, …)
- Legitimate Edge / DEFINER paths use service-role or opt-in GUC `onecab.allow_scheduled_trip_mutate`
- Manual Trip INSERT of create-time scheduled fields remains allowed (create Hard Rule #1)

## 3. Emergency actions + audit atomicity

- Every Edge action requires operational reason (≥3 chars)
- Airport + `assertPaymentGate` on publish/broadcast/assign paths
- `auditOrFail`: mutation success is not returned if `audit_logs` insert fails
- Assign Now: Edge → RPC (payment gate + CAS) → audit
- Cancel Ride: Edge → `apply_terminal_trip_cancellation` → scheduled board cleanup → audit

## 4. Non-card financial eligibility (verified, unchanged policy)

| Channel | Revolut auth | Still required |
|---|---|---|
| Card / Apple Pay / Google Pay | Yes (`assert_payment_gate`) | Capture coverage, airport, fare enrich |
| Cash / DRIVER_COLLECTED | Skip Revolut | Commission wallet at offer/accept; airport; fare |
| Corporate invoice / account | Skip Revolut | Corporate allowed methods at insert; account rules |

All routine channels use the same post-commit publication gate (`assertPaymentGate` + auto-publish CAS).

## 5. Retry exhaustion + blocker resolution

- Max attempts: **5** (`SCHEDULED_MARKETPLACE_PUBLISH_MAX_ATTEMPTS`)
- On exhaustion: `scheduled_hold_reason=publication_exhausted` + `ops_alerts` fingerprint
- Auto-publish never clears: exceptional / manual / unknown / airport / payment / exhausted
- Payment gate clear → `publication_pending` **only** when hold was `payment_gate`
- Airport release RPC → `publication_pending` when still held

## 6. Coordinated deploy sequence (when approved)

1. Dry-run: `supabase/scripts/scheduled_marketplace_phase3_dry_run.sql`
2. Migration `20270213120000_scheduled_marketplace_hold_reason.sql`
3. Migration `20270213130000_scheduled_marketplace_final_security.sql`
4. Edge (same cutover window — old Admin must not bypass):
   - `admin-scheduled-ride-action` (required)
   - `create-trip-after-payment` / CTAP consumers of `bookingPostCommit`
   - `scheduled-dispatch`, `schedule-dispatch`, `scheduled-ride-action`
5. Admin GitHub Actions publish (ScheduledRides + RolesPermissions + ManualTrip)
6. Lovable Central Hub publish (held create — already on Phase 3 branch)
7. Smoke: read-only staff mutation denied; Owner Make Available; airport hold; Assign Now audit row
8. **Do not** deploy older Admin after mutate lock — Cancel/Assign would break without Edge

### Temporary feature gating (if needed)

If Admin publish lags Edge/DB: emergency buttons already call Edge — they fail closed (403/5xx) rather than mutate. Restore by publishing Admin on `release/scheduled-marketplace-phase3`.

## 7. Rollback

`supabase/migrations/rollback/rollback_20270213130000_scheduled_marketplace_final_security.sql`

- Restores `admin_page_mutate` + `admin_assign_scheduled_driver` pre-final-security
- Keeps hold_reason column + airport trigger from `20270213120000`
- Does **not** weaken Phase 1/2 payment / capture / wave policy

Full marketplace rollback: also redeploy prior Edge + Admin + hub; optional hold_reason rollback only if required.

## 8. Config preserved (unchanged)

5d/120h max advance · 20 min min · capture +6h · strict coverage · instant 6m ·
waves 11/14/18 · expiry 45/30/30 · commission −0/−2/−3pp · scheduled response 4m ·
existing activation/urgent timings · stacking · wallets · airport allocation ·
incremental auth · MK buffer `false`/`2`.

## 9. GO / NO-GO

**CONDITIONAL GO for production** — code and tests ready; **NO-GO to deploy** until explicit production approval (migrations, Edge, Admin, Lovable, OTA).
