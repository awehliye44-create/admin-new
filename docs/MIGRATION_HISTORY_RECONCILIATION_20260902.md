# Migration history reconciliation — 2026-09-02

**Project:** `thazislrdkjpvvghtvzo` (production)  
**Repo:** `admin-new`  
**Remote tip (schema_migrations):** `20260901120000`  
**Local migration files:** ~416 (414 unique version stems; duplicates `20260609120000`, `20260705120000`)

## 1. Findings

| Class | Count (approx) | Meaning |
|-------|----------------|---------|
| Local + remote matched | Many | Healthy |
| Remote-only | Hundreds | Applied via dashboard / other branches; no local file |
| Local-only | Hundreds | Present in repo; not in remote history (may or may not match live schema) |
| Live schema without history | Driver workflow RPCs | Functions exist in prod but local migration files for `20260832210000` / `202608332*` are **missing from this checkout** |

Verified live (examples):

- `list_driver_own_trip_history`, `get_driver_own_wallet_summary`, `list_driver_own_scheduled_jobs`
- `list_driver_own_demand_zones`
- `get/set/clear_driver_own_towards_destination`
- `reset_towards_destination_uses` (trigger helper)

Documented earlier: `docs/PHASE_3F_DEPLOYMENT_AUDIT.md` — **blind `db push` is unsafe**.

## 2. Reconciliation plan (selected)

| Migration / object | Local | Production history | Schema effect present | Action |
|---|---|---|---|---|
| Pre-202609 remote-only versions | No | Yes | Assumed yes | **Leave** — do not invent local files |
| Local-only pre-202609 versions | Yes | No | Unknown / mixed | **Leave** — do not mark applied without per-file verification |
| Duplicate stems `20260609120000`, `20260705120000` | Dup files | Partial | Unknown | **Manual review** — cannot auto-reconcile |
| Driver workflow RPCs (history gap) | Files missing | Not listed as `202608322*` | **Yes** | **Forward reassert** optional; do not rewrite remote history |
| New towards allowance / matching | New forward files after remote tip | No | Pending apply | **Apply via `db query --linked`**, then `migration repair --status applied` for those versions only |
| Full `db push` | — | — | — | **Blocked** until a dedicated drift project reconciles remote-only ↔ local-only |

## 3. Preferred operating mode (until full drift cleanup)

1. Author forward-only migrations with timestamps **> `20260901120000`**.
2. Apply with `npx supabase db query --linked -f <file.sql>` (idempotent `CREATE OR REPLACE` / `ADD COLUMN IF NOT EXISTS`).
3. Record history: `npx supabase migration repair --status applied <version>`.
4. Never `db push` the entire local tree against production.
5. Never drop production objects to match local history.

## 4. Cannot safely auto-reconcile

- Mass `migration repair` of all local-only versions
- Deleting remote-only history rows
- Rewriting already-shipped Lovable UUID migrations
- Assuming every local-only file’s effect is already live

## 5. Rollback

Reconciliation documentation has no schema side effects.  
Forward migrations each include their own rollback notes in the SQL header.
