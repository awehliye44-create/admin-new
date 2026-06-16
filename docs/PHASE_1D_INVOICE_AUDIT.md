# Phase 1D-05 — Trip Invoice Writer Audit

**Date:** 2026-06-16  
**Status:** COMPLETE — writer SSOT fix deployed from passenger repo; display uses snapshots  
**Authority:** Financial Reconciliation SSOT

---

## 1. Invoice paths audited

| Path | Location | Role | SSOT status |
|------|----------|------|-------------|
| Edge function entry | `onecab-comfy-ride/supabase/functions/trip-invoice-process/index.ts` | Admin invoke + auto trigger | **Fixed** — payments join + settlement total |
| Invoice service | `onecab-comfy-ride/.../tripInvoiceService.ts` | PDF upload, email, `invoice_total_paid_pence` write | Writes payload from `buildTripInvoicePayload` |
| Invoice data / totals | `onecab-comfy-ride/.../tripInvoiceData.ts` | Line items + `resolveTotalPaidPence` | **Fixed** — `getTripSettlementFarePence()` |
| Invoice PDF | `onecab-comfy-ride/.../tripInvoicePdf.ts` | Renders `totalPaidPence` from payload | No legacy fare logic |
| Admin display | `admin-new/src/components/trips/TripInvoiceCard.tsx` | Shows snapshot + download/regenerate | **Snapshot only** — no live recalc |
| Trip History | `admin-new/src/pages/TripHistory.tsx` | Embeds `TripInvoiceCard` | Passes `invoice_total_paid_pence` |
| Schema | `trips.invoice_total_paid_pence` | Persisted at generation | Snapshot field — correct |
| `invoice_items` table | Driver monthly statements only | **Not** used for trip customer invoices | N/A |
| Admin repo config | `admin-new/supabase/config.toml` | `trip-invoice-process` registered | Source lives in **onecab-comfy-ride** |

---

## 2. Legacy fields found (pre-fix writer)

`tripInvoiceData.ts` `resolveTotalPaidPence` **before 1D-05**:

| Priority | Field | Risk |
|----------|-------|------|
| 1 | `capture_amount_pence` + tip | Stale trip capture; no `payments` join |
| 2 | **`gross_fare_pence` + tip** | **Legacy — not customer paid** |
| 3 | `computeFinalFarePence` | Fare engine, not settlement |
| 4 | `final_customer_fare_pence` | Display/promo only |
| 5 | `invoice_total_paid_pence` | Could prefer stale snapshot over capture |
| 6 | **`estimated_fare` / `fare`** | **Legacy quote** |

`buildLineItems` still uses `final_customer_fare_pence` for **line-item breakdown** display only. **Final Settlement Total** (PDF footer / `invoice_total_paid_pence`) now uses settlement SSOT.

**Driver net:** Not shown on customer invoice PDF. `getTripDriverNetPence()` available for future internal audit via `src/lib/tripInvoiceFinance.ts`.

---

## 3. Future writer SSOT compliance

| Rule | Implementation |
|------|----------------|
| Customer Paid / Final Settlement Total | `getTripSettlementFarePence()` via `resolveTotalPaidPence` |
| Card captured | `payments.captured_amount_pence` (joined in `buildTripInvoicePayload`) |
| Cash collected | `final_fare_pence` when `collected_cash` |
| Driver Net | `getTripDriverNetPence()` — not on customer PDF; helper in `tripInvoiceFinance.ts` |
| Never fare − commission | Enforced — no commission subtraction in writer |
| Never regenerate historical | Existing `invoice_total_paid_pence` / PDF unchanged until admin **Regenerate** |
| No fake values | Falls back to line-item sum only if settlement is 0 |

**Reference trips verified in tests:**

| Trip | Final Settlement Total |
|------|------------------------|
| MK-260615-006 | £5.12 (512p captured, not 480p gross) |
| MK-260615-017 | £5.23 |
| MK-260615-004 | £7.93 cash |
| MK-260615-019 | £4.80 |

---

## 4. Changes made

### onecab-comfy-ride (writer — deployed)

| File | Change |
|------|--------|
| `tripSettlementFinanceSSOT.ts` | **New** — edge SSOT helpers |
| `tripInvoiceData.ts` | Payments join; `resolveTotalPaidPence` uses settlement SSOT |
| `tripInvoiceData.test.ts` | Reference trip tests; removed gross-over-invoice test |

### admin-new (display + docs)

| File | Change |
|------|--------|
| `docs/PHASE_1D_INVOICE_AUDIT.md` | This audit |
| `src/lib/tripInvoiceFinance.ts` | Frontend SSOT helpers for invoice totals |
| `src/lib/__tests__/tripInvoiceFinance.test.ts` | Reference trip tests |
| `src/components/trips/TripInvoiceCard.tsx` | Label **Final Settlement Total**; snapshot comment |

**Not changed:** Historical PDFs, `regenerate` behaviour (admin-only), driver `invoice_items`, payout/ledger/webhook paths.

---

## 5. Tests run

- `onecab-comfy-ride`: `deno test supabase/functions/_shared/tripInvoiceData.test.ts`
- `admin-new`: `vitest run src/lib/__tests__/tripInvoiceFinance.test.ts`
- `admin-new`: `npm run build`

---

## 6. Deployment status

- `trip-invoice-process` edge function deployed from **onecab-comfy-ride** after SSOT fix
- `admin-new` pushed to `main` (docs + display helpers)

**Regenerate warning:** Admin **Regenerate PDF** will write new `invoice_total_paid_pence` using SSOT. Do not bulk-regenerate historical invoices.

---

## 7. Remaining invoice risks

| ID | Risk | Phase |
|----|------|-------|
| INV-01 | Line items still use `final_customer_fare_pence` for ride fare breakdown row | Follow-up — align breakdown to settlement components |
| INV-02 | `trip-invoice-process` source not in admin-new repo — deploy from onecab-comfy-ride | Ops — consider vendoring into admin-new |
| INV-03 | Stale `invoice_total_paid_pence` on trips generated before 1D-05 | Historical — valid until regenerate |
| INV-04 | Auto-invoice trigger (`tripInvoiceTrigger`) — same payload path | Low — uses fixed `buildTripInvoicePayload` |

---

## Stop gate

**Phase 1D-05 complete.** Do not start Phase 2 driver app work until approved.
