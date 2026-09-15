# Migration version decision (A4)

| Version | Status |
|---|---|
| `20260915120000` | **REJECTED** — collides with `accept_stacked_ride_max_queue_from_admin` on origin/main |
| `20261112180000` | **CANDIDATE** — unused on local + origin/main registries as of packaging; **not auto-approved** |
| Live tip known | through at least `20261112170000` |

Before apply: re-query production `schema_migrations` and repository migrations; pick a still-unused version if `20261112180000` is taken.
Source evidence tip preserved: `06d40440` on `rescue/local-atomic-fare-modification-20260915` (unchanged).
