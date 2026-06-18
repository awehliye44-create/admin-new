# Phase 3D.3A — Future Payouts £7.79 Audit

**Date:** 2026-06-18  
**Type:** Read-only  
**Probe:** `phase-3d3a-future-payout-probe` (deployed, no mutations)

---

## Finding: £7.79 is not a single payout ID

**Stripe Dashboard Future Payouts £7.79 matches exactly:**

| Component | Pence | GBP |
|-----------|-------|-----|
| Platform `balance.available` (Provider Available) | 666 | **£6.66** |
| Platform `balance.pending` (Incoming earnings) | 113 | **£1.13** |
| **Sum** | **779** | **£7.79** |

There is **no** platform `pending` or `in_transit` payout object for £7.79 at audit time. The dashboard figure is **platform cash queued for the next automatic platform bank sweep**, not a Connect driver payout.

---

## Answers to audit questions

### Owner account

**ONECAB platform account** — `acct_1RQrPREeK1Cb9ZBx`

(Not MK0001 / MK0002 Connect.)

### Payout ID

**None** for the £7.79 aggregate. No `po_…` object exists for this amount in `pending` / `in_transit` on the platform account.

### Payout type

**Platform** (ONECAB commission / platform Stripe balance → ONECAB bank).  
**Not** a Connect driver payout.

### Scheduled payout date

No explicit `po_…` object. Next execution is governed by **platform payout schedule**:

| Setting | Value |
|---------|-------|
| `interval` | **weekly** |
| `delay_days` | **3** |
| Automatic | **Yes** |

Stripe will create an automatic platform payout when the weekly schedule triggers on eligible balance (£6.66 available + £1.13 pending).

### Will it auto-execute?

**Yes** — platform automatic payouts to ONECAB bank are **enabled**. This sweep does **not** require ONECAB admin driver-payout approval (it is not a driver wallet debit path).

### Relationship to Provider Available £6.66

```
Provider Available (Admin) = platform balance.available only = £6.66
Future Payouts (Dashboard)  ≈ platform available + platform pending
                            = £6.66 + £1.13 = £7.79
```

Admin **excludes** the £1.13 pending slice from Provider Available; Stripe Dashboard **includes** it in Future Payouts.

---

## Separate Connect payout (not £7.79)

| Field | Value |
|-------|-------|
| Payout ID | `po_1TjdXrEXTz9Ab5Ic7xa29zfU` |
| Owner | **MK0001** Connect — `acct_1ThTrEEXTz9Ab5Ic` |
| Type | **Connect** → driver bank |
| Amount | **£2.78** (278p) — not £7.79 |
| Status | **pending** |
| Automatic | **false** (admin manual payout path) |
| Arrival date | 2026-06-18 |
| Ledger / payout_item | Linked — not orphan |

This payout **will execute** to Ahmed's bank but was created via admin payout flow (3D.1 incident), not by Stripe auto-schedule.

---

## Automatic payout without ONECAB admin approval?

### **YES — still possible**

| Path | Enabled? | Amount at risk | Admin approval? |
|------|----------|----------------|-----------------|
| **Platform → ONECAB bank** | Yes (weekly auto) | £7.79 (666+113p) | No (commission sweep) |
| **MK0001 Connect → driver bank** | Yes (daily, 7d delay) | **£9.54 pending** + £0.87 available | **No** |
| **MK0002 Connect → driver bank** | Yes (daily, 7d delay) | £0 now; any future credit | **No** |
| Admin `admin-driver-payout` | Locked (`ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=false`) | N/A | Yes when enabled |

**Connect auto-payout lockdown (Phase 3D.3) has not been applied.** MK0001/MK0002 remain `interval: daily`, `automatic_payouts_enabled: true`.

Any new Connect balance on MK0001 (**£10.41** avail+pending) can auto-sweep to driver bank without `payout_batches`, `payout_items`, or admin sign-off — same orphan pattern as `po_1TjTPX` / `po_1TjUCp`.

---

## GO / NO-GO

| Question | Answer |
|----------|--------|
| Is £7.79 a driver orphan risk? | **No** — platform balance, not Connect |
| Does £7.79 block understanding Provider Available? | **No** — explains as available + incoming |
| Can money still leave Stripe without admin approval? | **YES** — platform auto (£7.79) + Connect auto (MK0001 £9.54+ pending) |
| Proceed with 3D.3 Connect lockdown? | **GO** — still required |

---

## Stop condition

Read-only audit complete. No Stripe updates, ledger writes, or payout creation.
