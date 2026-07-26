# Towards Destination soft matching — deploy status

**RESOLVED 2026-07-26**

- Missing `_shared` modules were recovered from production `auto-dispatch` ESZIP (Management API body).
- Soft priority matching (no hard exclude) redeployed to production `auto-dispatch`.
- SQL helpers + allowance/expiry RPCs remain live from migrations `20260902120000` / `20260902130000`.

## Behaviour now
- Active unexpired towards preference within tolerance → bounded score bonus
- Incompatible / expired / cleared preference → driver remains normally eligible
- Core eligibility (SA, presence, radius, docs, etc.) unchanged
