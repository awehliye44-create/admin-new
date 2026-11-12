# Phase 6 — Scheduled Rides UI preview (code-level)

Admin route: **`/scheduled-rides`** (existing page — not a new route).

## Board

```
┌─ KPIs ─────────────────────────────────────────────────────────────┐
│  Total Scheduled   │  Today   │  Needs attention   │  Unassigned   │
└────────────────────────────────────────────────────────────────────┘

Filter: All | Today | Tomorrow | Unassigned | Needs attention

┌─ Table ────────────────────────────────────────────────────────────┐
│ Scheduled For │ Booking ID │ Passenger │ Route │ Vehicle │ Driver │
│ Status (+ Ack countdown / Needs attention) │ Fare │ Actions ▾     │
└────────────────────────────────────────────────────────────────────┘
```

### Status badge examples (presentation SSOT)

| Badge | When |
|-------|------|
| `Awaiting publication` | Unpublished scheduled |
| `Requested` | Marketplace published |
| `Confirmed` + PRE-CONFIRMED | confirmed_driver_id, no live driver_id |
| `JIT pending` | Awaiting JIT / activation window |
| `Awaiting departure ack` + `Ack 32s` | scheduled_ack_status=pending |
| `Heading to pickup` | ack=acknowledged **and** en_route |
| `Searching` | Replacement / converted rematch |
| `Payment blocked` / `Needs attention` | Genuine ops exception |
| `Expired` / `Cancelled` | Terminal (off live board) |

**Forbidden:** `Heading to pickup` while ack is null/pending/timed_out.

### Actions ▾

- View Details · Assign Driver · Cancel pending (if any)  
- **Emergency:** Broadcast · Make Available · Hold · Cancel Ride  

All emergency mutates → `admin-scheduled-ride-action` + Roles & Permissions (no parallel RBAC).

## Details dialog — Automatic workflow panel

```
Status badges…
┌ Automatic workflow ──────────────────────────────────────┐
│ Target arrival          │ JIT departure deadline         │
│ Driver-to-pickup ETA    │ Ack deadline / countdown       │
│ Payment readiness       │ Airport pricing                │
│ Compatible journey cue (when applicable)                 │
│ Replacement search status (when rematching)              │
│ Operational events (publish → accept → JIT → arm → …)    │
└──────────────────────────────────────────────────────────┘
Passenger · Route · Vehicle/Fare · Driver ownership SSOT
```

No new polling interval — same React Query refresh as existing Scheduled Rides page.
