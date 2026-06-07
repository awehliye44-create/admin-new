# P0 Payout Batches & Audit — Wrong Zeros Fix

**Date:** 2026-06-07  
**Page:** Admin → Payout Batches & Audit  
**Supabase project:** `thazislrdkjpvvghtvzo` (prod)  
**Test driver:** Ahmed Osman MK0001 (`58b29f86-6cf9-4492-b971-d17d8e0456c7`)

---

## Symptom

Milton Keynes filter selected; all stats showed **£0.00 / 0** despite driver wallet showing **£4.49 available**.

---

## Root cause

1. **Primary (stale frontend):** Older bundles read `edgeData.summary.availableForPayout || 0` from `admin-payout-batches` only. Any edge/auth failure silently rendered **£0** with no error banner.

2. **Secondary (semantics):** `driver_financial_summary.available_for_payout` = gross positive wallet balance (**£12.76**). Driver app uses `driver-wallet-summary` → `computeDriverWalletSummary`, which deducts in-flight early cashout reservations: **£12.76 − £8.27 reserved = £4.49**.

3. **Not the cause:** RLS, region_id mismatch, or empty ledger — prod data is correct for MK (`region_id = 7f611e59-a9e5-42c2-b65a-61376910bb5d`).

---

## Prod DB verification (2026-06-07)

| Metric | Value |
|--------|-------|
| Ahmed `wallet_balance` | **1276p (£12.76)** |
| Ahmed `available_for_payout` (gross) | **1276p (£12.76)** |
| In-flight early cashout (`processing`) | **827p requested / 777p driver receives** |
| **`net_available_for_payout`** (new) | **449p (£4.49)** — matches driver app |
| MK drivers ready (`net_available_for_payout > 0`) | **1** |
| Ledger sum (all types) | 1501p (PLATFORM_COMMISSION excluded from wallet_balance) |

---

## SSOT choice

| Surface | Field | Meaning |
|---------|-------|---------|
| Driver app wallet | `available_payout_pence` | `net_balance − reserved_cashout_pence` |
| Admin Driver Wallet | `wallet_balance` / `available_for_payout` | Gross ledger balance (unchanged) |
| **Admin Payout Batches** | **`net_available_for_payout`** | Same as driver app — payout-ready after reserved cashouts |

Implemented via migration `20260607143000_p0_driver_financial_summary_net_available.sql` adding `reserved_cashout_pence` and `net_available_for_payout` to `driver_financial_summary`.

---

## Fix applied

**Migration:** `supabase/migrations/20260607143000_p0_driver_financial_summary_net_available.sql`

**Frontend:** `src/pages/AdminPayoutBatches.tsx`

- Stats from `useDriverFinancialSummaries()` + client-side `region_id` filter (Driver Wallet pattern).
- **Available for Payout** uses `net_available_for_payout`.
- Error banners for driver summary and batch query failures (no silent zeros).
- Stats render without waiting on edge batch query.

**Edge function:** `admin-payout-batches` — summary uses `net_available_for_payout` for backwards-compatible API consumers.

---

## Expected UI after deploy + hard refresh

With **Milton Keynes (£)** selected:

| Stat | Value |
|------|-------|
| Total Batches | 0 |
| Total Paid Out | £0.00 |
| **Available for Payout** | **£4.49 (1 driver ready)** |
| Pending / Failed | 0 / 0 |

With **All Services**: financial stats remain **£0.00 / 0** (by design — no cross-region aggregation).

**Driver Wallet admin page (MK):** still shows gross **£12.76** wallet / available_for_payout in driver detail — use Payout Batches for net payout-ready amount.

---

## Deploy checklist (2026-06-07 update)

1. ~~`supabase db push`~~ — **DONE**: `net_available_for_payout` + `reserved_cashout_pence` live on prod view
2. ~~`supabase functions deploy admin-payout-batches`~~ — **DONE** (v169+)
3. ~~Admin RLS on `driver_early_cashouts`~~ — **DONE** (`Admins can view all driver early cashouts` policy live on prod)
4. ~~`payout_method` column~~ — **DONE** on prod (`instant` / `standard`)
5. **Publish admin frontend (Lovable Share → Publish)** — **REQUIRED** — prod bundle pre-dates Driver Early Cashouts section enhancements
6. Hard refresh admin panel (Cmd+Shift+R)

Automated Lovable publish via `LOVABLE_API_KEY` returned 401 Invalid token — use manual Publish in Lovable dashboard.

### Lovable publish (manual)

1. Open the admin project in [Lovable](https://lovable.dev) (linked to this repo)
2. Click **Share** (top right) → **Publish**
3. Wait for build to complete (~1–2 min)
4. Hard refresh production admin URL (Cmd+Shift+R)

No edge function deploy needed for early cashout list — admin reads `driver_early_cashouts` directly via RLS.

## Expected UI after publish (Payout Batches & Audit)

**Driver Early Cashouts** section is always visible (above Payout Batches), with status summary badges (processing / paid / failed).

| Filter | Ahmed cashout `553cf554` |
|--------|--------------------------|
| **Milton Keynes (£)** | Ahmed Osman · **processing** · £8.27 requested · £0.50 fee · **£7.77 net to bank** · Standard · `po_1TffdpImYgLhqfX0coqg8arU` |
| **All Services** | Same row + **Region: Uk1** column |

**Driver Wallet:** drivers with in-flight cashouts show an amber **£X.XX processing** badge in the In-flight cashout column.

## £7.77 processing (Ahmed cashout 553cf554)

| Field | Value |
|-------|-------|
| Stripe payout `po_1TffdpImYgLhqfX0coqg8arU` | **status: pending** |
| Payout method | **standard** (not instant) |
| Amount | 777p (£7.77) |
| Created | 2026-06-07 12:17 UTC |
| Expected arrival | **2026-06-08** (standard UK bank payout) |
| DB status | `processing` (correct — matches Stripe) |

**Not a webhook bug.** Cashout at 12:17 ran before instant-payout fix (12:25); instant was unavailable so driver-early-cashout fell back to **standard** payout despite £0.50 express fee. UI "Processing" is accurate until Stripe marks payout paid; `driver-wallet-summary` syncs status on next wallet refresh.
