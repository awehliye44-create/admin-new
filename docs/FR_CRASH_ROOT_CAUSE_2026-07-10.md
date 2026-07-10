# Financial Reconciliation crash — root cause proof (2026-07-10)

## Verdict

**Root cause:** Production `admin-finance-reconciliation` was overwritten by an onecab-comfy-ride Revolut-orphan stub during the four-page/hold deploy. Admin UI expects admin-new Financial Reconciliation SSOT (`finance_reconciliation_summary` via GET).

**Not caused by:** missing `financial-reconciliation` permission, Milton Keynes label IDs, or four-page React routes themselves.

## Layer table

| Layer | Expected | Actual | Error | Root cause |
|-------|----------|--------|-------|------------|
| Admin UI | LIVE SSOT | UNAVAILABLE | No cached snapshot | Wrong/missing response shape or CORS/network fail |
| Invoke | GET + query | GET | CORS `Allow-Methods: POST` on stub | Orphan stub CORS |
| Response | `finance_reconciliation_summary` | `revolut_provider_only` / orphan summary | Contract mismatch | Name collision overwrite |
| Auth | Admin JWT | 401 without JWT (OK) | N/A | Not the signed-in failure mode |
| Permission | `financial-reconciliation` | Present for SA | N/A | Not causal |
| Prod fn | admin-new SSOT (~1014 LOC) | onecab stub v89 (~53 LOC) | Wrong binary | Deployed from onecab |

## Authoritative backend

- **Owner:** `admin-new/supabase/functions/admin-finance-reconciliation/`
- **Retired collision:** onecab stub removed; orphan API renamed to `admin-revolut-orphan-reconciliation`

## Required restore (gated — do not deploy until approved)

```bash
cd /Users/admin/admin-new
supabase functions deploy admin-finance-reconciliation --project-ref thazislrdkjpvvghtvzo --no-verify-jwt
```

## UI resilience shipped (local, not deployed)

- Contract assert rejects orphan stub payloads
- 401 one-shot refresh; friendly 401/403/404/5xx/wrong-contract messages
- Diagnostics behind “View diagnostics”
- Snapshot key includes dates (`v2`)
- Duplicate page H1 removed
- Holds remain summary/link only on Overview
