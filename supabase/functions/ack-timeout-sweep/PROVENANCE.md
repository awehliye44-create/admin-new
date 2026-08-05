# ack-timeout-sweep — production restore provenance

Restored **before any local edits** from the live Supabase project.

| Field | Value |
|---|---|
| Project | `thazislrdkjpvvghtvzo` |
| Function slug | `ack-timeout-sweep` |
| Production version | **124** |
| Production `ezbr_sha256` | `d07e20a980d5bfaeaf5fffa8ce67ec198a5d8da5e9ae39b0170d6c4aa461f013` |
| Function id | `324acb67-10b8-4c86-a980-b147a4b9dbdf` |
| Restored at (local) | 2026-08-03 |
| Restore command | `supabase functions download ack-timeout-sweep` |
| Local `index.ts` SHA-256 | `919dc4bfc79dbe053c170d3d9e81c0dfc25b89e8673e762ddd0ff5df163c1c0b` |

Do not approximate this function from memory. Diff subsequent fixes against this restore.

## Post-restore local edits (not yet deployed)

Committed restore: `162b020` (`chore(ack-timeout-sweep): restore production v124 source verbatim`).

Local working-tree changes after that commit add:
- `assertCronOrServiceRoleAuth` (cron / service-role)
- sole redispatch ownership (SQL no longer HTTP-invokes `auto-dispatch`)
- skip timeout notify when driver has a newer pending offer
- `invalidates_offer_id` on timeout push payload
- richer redispatch observability

Compare with: `git diff 162b020 -- supabase/functions/ack-timeout-sweep/index.ts`
