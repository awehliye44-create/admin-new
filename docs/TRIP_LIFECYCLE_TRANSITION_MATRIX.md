# ONECAB Trip Lifecycle — Canonical Transition Matrix

**SSOT modules**

- Physical progression: `supabase/functions/_shared/tripLifecycle.ts`
- Formal matrix (status + dispatch + assignment + queue + waiting + payment): `supabase/functions/_shared/tripLifecycleTransitionMatrix.ts`
- Resolver: `resolveLifecycleTransition(action, actor, ctx, stops)`
- Invariants: `assertTripLifecycleInvariants(ctx, stops)`

Do not invent a second lifecycle model in React Native. Clients request actions and render projections.

## Pairing rules (production names)

| Physical `trips.status` | Expected `dispatch_status` | Assignment | Notes |
|---|---|---|---|
| offered / searching / broadcasting | broadcasting / offered | none | Pre-accept |
| accepted | assigned | confirmed_driver_id set | En route to pickup |
| arrived_at_pickup / pickup_waiting | assigned | assigned | Waiting SSOT timestamps |
| in_progress | assigned | assigned | Customer live marker hidden per policy |
| queued | assigned | assigned, not active | Stacked; no physical progress |
| searching_new_driver | searching_new_driver | cleared + excluded | Rematch after driver pre-start cancel |
| completed | completed | cleared | Capture/settlement |
| cancelled | cancelled | cleared | Terminal cancel |
| no_show | no_show | cleared | Completed history, not Cancelled |

## Illegal combinations (logged / rejected)

- completed + active dispatch (`assigned` / `broadcasting`)
- cancelled + assigned driver
- no_show + assigned driver
- queued + `is_driver_active_trip`
- in_progress without assigned driver
- completed with pending intermediate stops

Destructive DB CHECKs deferred until production violation audit with service role.

## Actions (summary)

See `LIFECYCLE_MATRIX_DOC_ROWS` and Deno tests in `tripLifecycleTransitionMatrix.test.ts`.

Key behaviours:

1. **Accept** assigns; does not start.
2. **Arrive** starts free waiting; idempotent.
3. **Start** requires arrival; finalises waiting; hides live location.
4. **Complete** requires in_progress + no pending stops; dispatch=`completed`; capture_pending; promote queue.
5. **Driver cancel before start** → rematch (`searching_new_driver`), customer trip survives.
6. **No-show** → `no_show` / clear assignment; eligibility threshold enforced in Edge with server time.
7. **Promote queued** → accepted/assigned active; system after Trip A complete.
8. **Cancel queued** → rebroadcast; Trip A unchanged.

## Error codes

`TRIP_NOT_FOUND`, `NOT_ASSIGNED_DRIVER`, `INVALID_TRIP_STATE`, `INVALID_DISPATCH_STATE`, `INVALID_QUEUE_STATE`, `ACTION_ALREADY_COMPLETED`, `STALE_TRIP_VERSION`, `NO_SHOW_NOT_ELIGIBLE`, `STOPS_INCOMPLETE`, `QUEUED_TRIP_NOT_CANCELLABLE`, …

## Schema confirmation (Phase 2 — recovered signatures)

Production RPCs referenced by stacked-ride lifecycle. Migrations recover repo history; prod already has these functions.

| Function | Args | Returns | Grants / mode |
|---|---|---|---|
| `promote_stacked_trip` | `p_driver_id uuid`, `p_completed_trip_id uuid DEFAULT NULL` | `jsonb` (`promoted`, `trip_id`, `trip`, …) | SECURITY DEFINER; `authenticated`, `service_role` |
| `get_driver_active_trip_snapshot` | _(none — JWT via `auth.uid()`)_ | `jsonb` (`server_now`, `driver_id`, `active_trip`, `queued_trips`, no-show fields, `permitted_actions`) | SECURITY DEFINER; `authenticated`, `service_role` |
| `get_driver_queued_trips` | _(none — JWT via `auth.uid()`)_ | `jsonb` (ordered queued trip array) | SECURITY DEFINER; `authenticated`, `service_role` |
| `can_modify_trip` | `p_trip_id uuid` | boolean/json | SECURITY DEFINER |
| `apply_trip_modification_to_trip` | trip + fare snapshot args | void | SECURITY DEFINER |
| `apply_terminal_trip_cancellation` | `p_trip_id`, optional actor/reason | `jsonb` | SECURITY DEFINER (Admin terminal) |

Migration files:

- `supabase/migrations/20260904110000_get_driver_queued_trips.sql`
- `supabase/migrations/20260904120000_get_driver_active_trip_snapshot.sql`
- `supabase/migrations/20260904130000_promote_stacked_trip.sql`
- `supabase/migrations/20260904140000_get_driver_active_trip_snapshot_no_show_fields.sql`

Cancellation / rematch SSOT:

- `supabase/functions/_shared/cancellationOutcome.ts`
- `supabase/functions/_shared/executeDriverCancelRematch.ts`
- Edge `driver-cancel-before-pickup` (recovered; shared helper)
- `stop-workflow` `driver_cancel` routes pre-start → rematch, post-start → terminal

No-show path: Edge `cancel-trip` with `is_no_show=true` (driver); eligibility from `waitingAdminConfig` / snapshot fields.

Violation probe (read-only; no CHECKs yet):

- `docs/sql/trip_lifecycle_violation_probe.sql`
- Table `trip_state_violations` + trigger `tr_observe_trip_state_violation` + function `log_trip_state_violation` recovered in `supabase/migrations/20260904150000_trip_state_violations_observe.sql` (observe mode; never blocks writes).
- Edge matrix/lifecycle blocks also INSERT via `_shared/logTripStateViolation.ts`.

Stop waiting: Edge `stop-workflow` + `stop-waiting` (deployed); response includes waiting + no-show snapshot fields.

## Phase 1 / Phase 2 gate status (2026-07-26)

**Phase 1 — PASS**

- Matrix: `_shared/tripLifecycleTransitionMatrix.ts` + `docs/TRIP_LIFECYCLE_TRANSITION_MATRIX.md`
- Invariants: enforced on progression (`INVARIANT_VIOLATION`); corrective/terminal actions may heal dirty rows
- Pairings: `EXPECTED_STATUS_DISPATCH_PAIRINGS` + `LIFECYCLE_MATRIX_DOC_ROWS` (full action set)
- Deno: matrix + lifecycle + cancellationOutcome — **50 passed**
- Production violation probe: **0 rows** (no destructive CHECKs added)
- Callers: `stop-workflow` (matrix-only gate), `cancel-trip`, `accept-trip`, `admin-trip-action` `force_complete`, rematch via `executeDriverCancelRematch`
- Admin Active Trips cancel → `cancel-trip` (matrix outcome)
- Observe trigger extended to I1–I5 (`20260904160000_trip_state_violations_observe_extend.sql`)

**Phase 2 — PASS (code + unit); live E2E remaining**

| Step | Status |
|---|---|
| 2.1 Accept projection | Live accept applies backend snapshot; workflow timeout rehydrates |
| 2.2 Active-trip hydrate | `get_driver_active_trip_snapshot` + resume wiring |
| 2.3 Stacked promotion | Server `promote_stacked_trip`; client hydrates only |
| 2.4 No-show | `cancel-trip` + server eligibility; client clock display-only |
| 2.5 Customer observer | Global restore + `mapCustomerTripUiPhase` |
| 2.6 Cancel/rematch UX | Assigned cancel wired; rematch calm copy; no white flash |
| 2.7 Modifications | Hydrate + version conflict + safe UI state mapping |
| 2.8 Cancel consolidation | `cancellationOutcome` + rematch helper + Admin via cancel-trip |
| 2.9 Schema | Migrations recovered; observe I1–I5 applied |

Deployed Edge (project `thazislrdkjpvvghtvzo`): `stop-workflow`, `accept-trip`, `cancel-trip`, `admin-trip-action`.

Remaining (non-blocking): live device E2E; rich Customer modification negotiation sheet (safe UI states wired; full negotiate UX deferred); payment Edges not matrix-gated (wallet/payment SSOT untouched); queued `can_cancel` intentionally `true` while `status=queued` (matrix enforces cancel_queued_trip).

