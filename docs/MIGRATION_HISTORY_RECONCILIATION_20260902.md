# Migration history reconciliation — 2026-09-02

**Project:** `thazislrdkjpvvghtvzo` (production)  
**Repo:** `admin-new`

## Findings

Severe local ↔ remote migration history drift. Blind `db push` is **unsafe**.

| Class | Action |
|-------|--------|
| Remote-only versions | Leave |
| Local-only versions | Leave until per-file verified |
| Forward migrations after remote tip | Apply via `db query --linked`, then `migration repair --status applied` |

## Applied forward migrations (verified)

| Version | Purpose |
|---------|---------|
| `20260902120000` | Towards Destination allowance/expiry |
| `20260902130000` | Towards Destination priority bonus SQL helper |
| `20260902140000` | Demand-zone auto visibility / invalid geometry guard |

## Operating mode

1. Author forward-only migrations with timestamps after remote tip.
2. Apply with `npx supabase db query --linked -f <file.sql>`.
3. `npx supabase migration repair --status applied <version>`.
4. Never whole-tree `db push` against production.
