# Slice 9 — Controlled historical repairs

**Status:** Applied & verified (2026-07-12).  
**See also:** onecab `docs/P0_SLICE9_HISTORICAL_REPAIRS.md` + dry-run/apply JSON artifacts.

## Summary

Three MK Revolut trips:

1. Release evidence → `AMOUNT_UNCONFIRMED` (amount stays NULL — no invent)
2. `onecab_net` 007/010 corrected 72→47 from ACTUAL fees (008 already 78)
3. Wallet Ahmed 1001 / Bosteyo 408 unchanged
4. Auth children skipped (no multi-order proof)

FR treats `AMOUNT_UNCONFIRMED` as non-actionable Missing Release (Slice 1/5).
