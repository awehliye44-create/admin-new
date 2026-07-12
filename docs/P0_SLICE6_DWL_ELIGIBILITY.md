# Slice 6 — Driver Wallet balance / eligibility parity

**Status:** Deployed & verified (2026-07-12).  
**Scope:** DWL ↔ PL Available/Pending parity. No payouts, no historical invent, no Slice 7+.

## Contract

- Live balance = ledger SSOT (exclude PLATFORM/COMPANY commission, provider fees, cash trip earning, informational)
- Available / Pending from **one** canonical function: `aggregateDriverPayoutEligibility` / `fetchDriverPayoutEligibility`
- `pending = live − available` (held / not eligible) — same on DWL and PL
- DES companion optional — missing DES must not erase valid credits when PS + settlement + ledger complete
- Missing capture → `CAPTURE_PENDING` (never `RECONCILIATION_PENDING` catch-all)

## Required values (unchanged)

Ahmed £10.01 · Bosteyo £4.08 · Fleet £14.09

## Exact files

| File | Role |
|---|---|
| `shared/driverPayoutEligibilitySSOT.ts` | CAPTURE_PENDING when no capture; DES not a hold alone |
| `shared/onecabFinanceLedger.ts` | Unified `BALANCE_EXCLUDED_LEDGER_TYPES` |
| `admin-new/.../fetchDriverWalletPayoutSnapshot.ts` | Remove DES cleared fallback; pending = eligibility |
| `admin-new/.../driverWalletPeriodWidgetsSSOT.ts` | Consume shared exclude list |
| `DriverWalletOverviewCards.tsx` | Pending hint = PL semantics |
| `driverWalletFleetOverviewSSOT.ts` | Prefer `pending_balance_pence` |

## Deploy

- `admin-driver-wallet-ssot`
- `admin-payout-ledger` (or accounts overview function if separate)
- Mirror onecab eligibility if PL reads from customer repo

## Acceptance

- DWL Pending ≡ PL Pending for Ahmed/Bosteyo
- Every held penny has a specific status
- Platform commission never in live balance
- No React sums
