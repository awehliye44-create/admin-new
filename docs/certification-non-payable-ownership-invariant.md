# CERTIFICATION_NON_PAYABLE — payment_session ownership invariant (proposal)

## Read-only duplicate audit (production, 2026-09-25)

Trips with `payment_session_id IS NOT NULL`: **593**
Duplicate `payment_session_id` groups: **2**

| payment_session_id | trips referencing it | session.trip_id owner | Notes |
|---|---|---|---|
| `bfab32d2-a52d-4f4f-b1a6-596a32b61a95` | MK-260923-010, **MK-260923-011** | MK-260923-010 | Cert trip stale FK — target of this repair |
| `413ad088-f8ba-4ed0-8f57-4b20ed1d77c3` | MK-260806-031, MK-260806-032 | `NULL` | Cancelled pair; session unowned |

## Proposed invariant (do not enforce yet)

```
IF trips.payment_session_id IS NOT NULL THEN
  payment_sessions.id = trips.payment_session_id
  AND payment_sessions.trip_id = trips.id
```

## Why not a UNIQUE constraint yet

`UNIQUE (trips.payment_session_id)` would block the two legacy duplicates above
and any future race. Count + review legacy rows first; clear or re-home them;
then consider:

1. Trigger `trips_payment_session_ownership` enforcing owner match on INSERT/UPDATE
2. Optional partial unique index on `payment_sessions(trip_id)` where trip_id not null
   (session → trip is the canonical ownership direction)

## Certification producer

No in-repo producer for `client_action_id = cert-board-exclusivity-{uuid}` was found
(admin-new / ONECAB local trees). External board harness must set
`payment_session_id = NULL` on certification inserts.
