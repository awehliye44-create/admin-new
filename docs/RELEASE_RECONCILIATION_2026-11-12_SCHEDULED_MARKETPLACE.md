# ONECAB — Release Reconciliation Report

**Date:** 2026-11-12 (UTC)  
**Scope:** Scheduled marketplace live sync + capture/create parity + related approved hotfixes  
**Mode:** Read-only reconciliation — **no deployment, no migration apply, no OTA, no frontend publish** in this pass  
**Production project:** `thazislrdkjpvvghtvzo`

---

## Executive verdict

| Question | Answer |
|---|---|
| **GO / NO-GO for further coordinated deploy of this release** | **NO-GO — nothing required remains pending** |
| **Why** | Migrations `20270218120000`–`20270218130300`, required Edge bundles, Admin Pages, Driver production OTAs, Customer hotfix OTAs, and Hub/Corporate payment-first live markers are already in production |
| **Phase 5** | **Not enabled** (`scheduled_departure_ack_enabled=false`, `jit_auto_activate_enabled=false`) |
| **MK-261112-006** | Remains `cancelled` — do not resurrect |
| **Next action** | Wait for explicit Owner approval before any *new* release; do not re-run this release sequence |

Publication ≠ device adoption. Driver/Customer OTA groups are published; install/adopt rates were not measured.

---

## 1. Repository audit

### 1.1 Admin / Supabase backend — `/Users/admin/admin-new`

| Field | Value |
|---|---|
| Current branch | `main` |
| Local HEAD | `abc2d02ecdc836f9765f844f3c4755e19085f486` |
| Remote `origin/main` | `abc2d02ecdc836f9765f844f3c4755e19085f486` (in sync) |
| Uncommitted / untracked | **none** |
| Unpushed commits | **none** |
| Stashes (do not discard) | `stash@{0}` trip-capture temp; `stash@{1}` corporate-signup wip; `stash@{2}` pre-gap-verify |
| Intended release commit | **`abc2d02e`** (merge of `fix/scheduled-booking-gap-closure-final`) |
| Production inclusion | **Included** (main = production SSOT for this release) |

**Unmerged / overlapping (EXCLUDE from this release):**

| Branch / PR | Classification |
|---|---|
| `fix/scheduled-booking-gap-closure-final` @ `9ee1ea0f` | **Superseded** — merged into `main` via `abc2d02e` |
| `release/scheduled-*` Phase 1–6 lines | **Historical / superseded** by gap-closure merge |
| `release/scheduled-departure-ack-phase5` | **Intentionally deferred** (Phase 5) |
| `release/trip-capture-deferral` (+ stash) | **Unrelated / deferred** |
| `fix/payout-*`, `release/admin-payout-*`, `fix/google-pay-*`, fleet/docs worktrees | **Unrelated** |
| Open PRs `#123`…`#20` (account deletion, waiting SSOT drafts, etc.) | **Unrelated / obsolete drafts** — do not merge with this release |

### 1.2 Driver native — `/Users/admin/onecab-driver-native`

| Field | Value |
|---|---|
| Current branch | `hotfix/accept-failure-sanitize` |
| Local HEAD | `1302f415b71186a31620eb9aa7b5ae4a1cbbd5ac` |
| Remote default (`origin/master`) | `3ea1bb48e51d6dbe19d21ed3bc192a548dfcaa6c` |
| Ahead of master | **17 commits** (includes scheduled live sync + prior prod hotfixes) |
| Uncommitted / untracked | **none** |
| Stashes | Multiple historical WIPs — **do not discard** |
| Open PRs | none |
| Production OTA source | **`1302f415`** (published) |
| Master merge hygiene | Tip **not** on `master` yet — lineage hygiene only; **not required for OTA** |

**Branch classification:** `hotfix/accept-failure-sanitize` = **required production OTA line**. Phase 5 UI commits are present in the tip ancestry but **runtime-gated off** by backend flags. Other local recovery/release branches = **obsolete / experimental / superseded**.

### 1.3 Customer native — `/Users/admin/onecab-customer-native`

| Field | Value |
|---|---|
| Current branch | `hotfix/instant-book-max-depth-guard` |
| Local HEAD | `43bb1a560b9785a19e33ba67b0494f7dc317ed75` |
| Remote default (`origin/master`) | `ec494d41dc3bf208c2542c25197201d9a3464c20` |
| Ahead of master | **3 commits** (instant Book max-depth + Rides spinner fixes) |
| Uncommitted | **none** |
| Untracked | `.env.qa.emulator`, `.env.qa.simulator` — **local QA only; exclude** |
| Stashes | 1 browser-tabs preserve stash — **do not discard** |
| Production OTA source | Tip message matches **`43bb1a5`** line (published) |

**Classification:** Required Customer hotfix train (**OTA-compatible**). Not part of scheduled-marketplace Edge/migration deploy, but already published and must be retained.

### 1.4 Website / Hub + Corporate portal — `/Users/admin/onecab-central-hub`

Corporate UI lives in this same Lovable repo (not a separate git remote).

| Field | Value |
|---|---|
| Current branch | `main` |
| Local HEAD | `820c7f662c9aa01f0bd5901fceffe18d71bf3afa` |
| Remote `origin/main` | `820c7f662c9aa01f0bd5901fceffe18d71bf3afa` |
| Uncommitted / untracked | **none** |
| Stashes | **none** |
| Live site | `https://co.onecab.net/` (Lovable; `onecab-central-hub.lovable.app` → 302) |
| Live deploy id | `psr2.dde784c3-ec11-44aa-afe7-5294b4fb398e.1795112326…` |
| Payment-first live evidence | Bundle contains `create-preauth-payment-intent`, `create-trip-after-payment`, payment-first user strings, `publication_pending` / `admin_held` |

**Unmerged:** `fix/corporate-signup-anti-stuck` (`2b2d98f`) — **3 commits not in main**. Diff shows it is **partially obsolete/divergent** vs current main (would drop main’s Phase 3 held + `publication_pending` client insert shape). **Exclude** from this release; treat as separate product decision (orphan recovery / anti-stuck), not scheduled-marketplace.

Open corporate review PRs `#1`–`#12` — **stale / draft; exclude**.

### 1.5 Other trees (out of release scope)

| Path | Note |
|---|---|
| `onecab-premium-build` | Dirty (`src/lib/onecabBackend.ts`); **unrelated** |
| `onecab-central-hub-audit` | Audit clone; **exclude** |
| Admin worktrees (`wt-admin-*`, `admin-new-*-release`) | Parallel unrelated lines; **exclude** |

No separate `onecab-corporate*` or `onecab-comfy-ride` checkout was present under `/Users/admin` for this audit.

---

## 2. Supabase migration reconciliation

**Method:** `scripts/check-migration-history-vs-prod.sh` + direct `supabase_migrations.schema_migrations` query.  
**Do not** `supabase db push` / repair / re-apply.

| Class | Versions / notes |
|---|---|
| **Applied and recorded (this release)** | `20270218120000` commitment/wallet SQL gates; `20270218120100` Admin assign atomic; `20270218130000` auto-publish/webhook create; `20270218130100` retire manual controls; `20270218130200` finalize create parity; `20270218130300` marketplace Realtime private auth |
| **Applied and recorded (prior required deps)** | Phase1 finance `20270201120000`–`202`, marketplace hold/security `20270213120000`–`400`, JIT/ack schema `20270214120000` / `20270215120000`–`300` (**flags remain false**), financial_model coalesce `20270216120000`, vehicle staff `20270217120000` |
| **Pending production application** | **none** (local-only list empty) |
| **Historical remote-only (no local file)** | `20261106194500`, `20261217120000`–`20261220120000`, `20261223140000`, `20261227190000`, `20261228193000`, `20261228194500`, `20270111120000`, `20270111120100` — treat as **historical remote-only**; do not invent local twins |
| **Superseded / intentional Phase 5** | Ack/JIT *schema* applied; *runtime enablement* deferred |
| **Conflicting / unsafe** | **none found** for this release set |

**Counts:** production recorded versions **842**; local migration files **831**.

---

## 3. Edge Function reconciliation

Downloaded production sources compared to `admin-new` `main` for the release set:

| Function | Prod version | Updated (UTC) | Local vs prod | Pending? | Migration deps |
|---|---|---|---|---|---|
| `revolut-webhook` | **v321** | 2026-11-12 18:06:47 | **MATCH** | none | 300/302 create+deadline |
| `create-trip-after-payment` | **v520** | 18:06:50 | **MATCH** | none | 300/302 |
| `confirm-revolut-payment` | **v183** | 18:06:54 | **MATCH** | none | capture gates |
| `scheduled-dispatch` | **v641** | 18:06:57 | **MATCH** | none | auto-publish + broadcast |
| `admin-scheduled-ride-action` | **v5** | 18:07:01 | **MATCH** | none | 201 assign + wallet |
| `scheduled-ride-action` | **v587** | 18:07:04 | **MATCH** | none | 200 commitment/wallet |
| `cancel-trip` | **v719** | 18:07:09 | **MATCH** | none | marketplace invalidate |
| `accept-offer` | **v550** | ~17:43 | **MATCH** | none | commitment gates |
| `auto-dispatch` | **v750** | ~17:43 | (touched same day; commitment static imports on main) | none for this release | — |
| `create-corporate-book` | **v86** | earlier | **MATCH** | none | payment-first backend |

**Shared modules verified in deployed download tree:**

- `scheduledMarketplaceRealtimeBroadcastSSOT.ts`
- `scheduledMarketplaceAutoPublishSSOT.ts`
- `scheduledMarketplaceCommissionWalletGate.ts`

**Rollback priors (scheduled set):** webhook 320, CTAP 519, confirm 182, dispatch 640, admin-scheduled 4, scheduled-ride 586, cancel 718.

**Intended release commit for Edge source:** Admin `abc2d02e` / pre-merge tip `9ee1ea0f` (same function bodies now on `main`).

---

## 4. Admin / Website / Corporate frontend reconciliation

### Admin (`adminonecab.net`)

| Check | Result |
|---|---|
| Intended commit | `abc2d02e` |
| Publish mechanism | GitHub Pages workflow on **`main` only** |
| Evidence | Run `43277013201` success; `last-modified` 2026-11-12 18:11:17 UTC; asset `index-BySERAHD.js` + `ScheduledRides-CAPCvAMF.js` |
| Retired controls | Live ScheduledRides chunk: **Make Available / Broadcast Now / Hold for Admin = 0** |
| Assign retained | `assign_now` / `assign_at` remain (Admin assignment — not retired) |
| Lovable | Admin also Lovable-origin; **production path used is GitHub Pages**, not a separate Lovable Share step for this release |

### Website public booking + Corporate (`co.onecab.net`)

| Check | Result |
|---|---|
| Intended commit | Hub `820c7f6` (BookingForm payment-first + server scheduled window) |
| Publish mechanism | **Lovable** (custom domain). GitHub merge ≠ automatic proof; live bundle was checked |
| Live payment-first | **Present** (`create-preauth-payment-intent`, `create-trip-after-payment`, fail-closed card strings) |
| Live scheduled hold client shape | **Present** (`publication_pending`, `admin_held`, `scheduled_hold_reason`) |
| Corporate BookRide on main | Payment-first via CTAP already on `main` |
| Unmerged anti-stuck branch | **Exclude** (divergent; would regress hold insert shape) |

**Required Lovable step for this release:** none further if live markers remain as verified. Any future Hub change still needs explicit Lovable Publish (or equivalent) after merge.

---

## 5. Driver and Customer OTA reconciliation

### Driver

| | Android | iOS |
|---|---|---|
| Runtime | `1.0.6(64)` | `1.0.6(4)` |
| Channel / branch | `production` | `production` |
| Canonical group ID | `bf0ac45e-d391-4f76-a452-f81436e537ec` | `7c3d82c1-35b1-431c-bbe7-834d53d1065f` |
| Source commit | `1302f415` | `1302f415` |
| Message | Scheduled Jobs live marketplace sync (private realtime) | same |
| OTA-compatible? | **Yes** (JS-only) | **Yes** |
| Native build required? | **No** for this tip | **No** |

**Included in published tip:** private marketplace Realtime + softRefresh; live banner/list; Accept error sanitize (`c9867d8`); vehicle-change UX; prior Home/docs/chat hotfixes in ancestry; Phase 5 UI code present but **flags false**.

**Superseded OTA:** Android group `d853c71b-…` published without `--environment production` — **superseded** by `bf0ac45e-…`.

**Not yet on `master`:** same 17 commits — merge hygiene only.

**Device adoption:** unknown / not verified.

### Customer

| | Android | iOS |
|---|---|---|
| Runtime | `1.0.5(45)` | `1.0.5(22)` |
| Channel / branch | `production` | `production` |
| Latest group ID | `4d105299-da3b-4db9-b25a-5d57a71d6e19` | `7ce7a20b-462e-408f-ae3d-fd8922700747` |
| Tip source | `43bb1a5` (rides tab remap after Schedule Book) | same line |
| Prior groups on channel | max-depth `4be6263`; spinner `bdd37a3` | same |
| OTA-compatible? | **Yes** | **Yes** |
| Native build required? | **No** for this tip | **No** |

**Scheduled-marketplace client work:** none pending on Customer for this release (backend + Driver Realtime).

---

## 6. Scheduled booking corrections — inclusion matrix

| Required correction | Where | Status |
|---|---|---|
| CTAP ↔ Revolut webhook create parity | SQL 300/302 + CTAP/webhook Edge | **Live** |
| Capture deadline persistence / fail-closed | SQL 302 + Edge | **Live** (isolated concurrency verify OK) |
| Automatic marketplace publication | autoPublish SSOT + dispatch | **Live** |
| Automatic publication recovery | dispatch recovery paths | **Live** (code); opportunistic for premature holds |
| Live Scheduled Jobs banner + list | Driver `1302f415` OTA | **Published** |
| Realtime service-area broadcasts (private, no PII) | SQL 303 + broadcast SSOT + Driver hook | **Live** |
| Driver commitment feasibility | SQL 200 + accept/ride-action | **Live** |
| Commission Wallet eligibility | SQL 200/201 + gates | **Live** |
| Atomic Admin assignment | SQL 201 + admin-scheduled-ride-action | **Live** |
| Website payment-first booking | Hub `820c7f6` + live bundle | **Live** |
| Remove legacy manual controls | SQL 301 + Admin UI | **Live** |
| Accurate Admin monitoring | Admin `abc2d02e` ScheduledRides | **Live** |
| Instant booking + Driver Accept hotfixes | Customer OTA + Driver Accept sanitize | **Published** |
| Corporate payment-first | Hub main BookRide + Edge `create-corporate-book` | **Live on main/Edge** |
| Corporate signup anti-stuck extras | unmerged branch | **Missing from main — excluded (divergent)** |

Isolated concurrency evidence (`/tmp/conc_out4.txt`): all 10 cases `ok`, including CTAP-first, webhook-first, duplicate delivery, missing/insufficient capture deadline fail-closed, instant unaffected.

---

## 7. Production safety (verified read-only)

| Control | Value |
|---|---|
| `scheduled_departure_ack_enabled` | **false** |
| `jit_auto_activate_enabled` | **false** |
| MK-261112-006 | `status=cancelled`, `scheduled_status=cancelled` |
| Active booking / payment mutation in this pass | **none** |
| Cron | `scheduled-dispatch-every-minute` + `schedule-dispatch-every-minute` **active** |
| Realtime policy | `Drivers receive scheduled marketplace broadcast` **present** |

---

## 8. Consolidated release manifest

### Final intended commits (this release)

| Surface | Commit |
|---|---|
| Admin / Edge / migrations | `abc2d02ecdc836f9765f844f3c4755e19085f486` |
| Driver OTA | `1302f415b71186a31620eb9aa7b5ae4a1cbbd5ac` |
| Customer OTA (hotfix retain) | `43bb1a560b9785a19e33ba67b0494f7dc317ed75` |
| Hub / Corporate frontend | `820c7f662c9aa01f0bd5901fceffe18d71bf3afa` |

### Pending migrations

**None.**

### Pending Edge deployments

**None** for the scheduled release set (local MATCH prod).

### Pending frontend publications

**None required** for Admin (Pages live) or Hub payment-first (Lovable live markers).  
**Excluded pending:** corporate anti-stuck branch (needs separate redesign/rebase before any publish).

### Pending OTAs / native builds

| Item | Status |
|---|---|
| Driver Android/iOS OTA | **Already published** (canonical groups above) |
| Customer Android/iOS OTA | **Already published** |
| New native builds | **Not required** for current tips |

### Uncommitted / unmerged work (explicit exclusions)

- All Admin payout/GPay/fleet/docs/Phase5 enablement branches and open unrelated PRs  
- Admin + Driver + Customer stashes  
- Customer `.env.qa.*`  
- Hub `fix/corporate-signup-anti-stuck` and draft corporate PRs  
- `onecab-premium-build` dirty file  
- Phase 5 flag enablement  
- Experimental / recovery Driver branches not on hotfix tip  

### Outstanding verification (non-blocking for deploy; no device/paid booking)

1. Device adoption rates for Driver `bf0ac45e` / `7c3d82c1` and Customer latest groups  
2. Optional: merge Driver hotfix → `master` and Customer hotfix → `master` for git lineage only  
3. Optional separate track: rebase corporate anti-stuck onto current Hub main without regressing hold insert  
4. Continue leaving MK-007-class premature holds to auto-publish recovery (do not hand-mutate)

### Coordinated deployment sequence (if Owner re-approves a *replay*)

**Not recommended — already applied.** If forced replay were ever needed:

1. Confirm flags still false; confirm MK-006 still cancelled  
2. Migrations — skip if recorded (do not re-apply)  
3. Edge — only redeploy if `diff` vs download shows drift  
4. Admin Pages — only if `main` moves  
5. Hub Lovable Publish — only if Hub tip moves  
6. Driver then Customer OTA — only for new SHAs  
7. Stop; do not enable Phase 5  

### Rollback plan

| Layer | Action |
|---|---|
| Edge | Redeploy prior versions listed in §3 |
| Admin UI | Redeploy previous GitHub Pages artifact / prior `main` SHA |
| Driver OTA | `eas update:rollback` / republish prior groups (`0d4023f0` Android Accept sanitize / `c97cae43` iOS) |
| Customer OTA | Republish prior groups on `1.0.5(45)` / `1.0.5(22)` |
| SQL | Use versioned rollback scripts under `supabase/migrations/rollback/` only with explicit approval; prefer forward fixes |
| Flags | Keep both false; drain script exists for Phase 5 if ever enabled |

### GO / NO-GO

**NO-GO for additional coordinated production deployment of this scheduled-marketplace release.**

Reason: required migrations, Edge, Admin, Hub payment-first, Driver OTA, and Customer hotfix OTA are already production-aligned. Further action requires a **new** explicit Owner approval for a different scope.

---

## 9. Restrictions observed

- No new features, refactors, migrations, deploys, OTAs, or frontend publishes in this reconciliation pass  
- No physical-device / simulator / paid-booking testing  
- No discard/reset/commit of dirty or stashed work  
- No Phase 5 enablement  
- No mutation of MK-261112-006 or live payment authorisations  
