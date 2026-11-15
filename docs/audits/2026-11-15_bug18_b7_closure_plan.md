# Bug #18 / Stream B7 — Closure plan (read-only)

**Date:** 2026-11-15 (resumed from deferred backlog)  
**Mode:** Analysis + proposed fix scope only. **No implement / deploy / OTA / paid bookings** until explicit approval.  
**Stream confirmed:** B7 / Bug #18 — Revolut incremental authorisation on trip modification.

**Prior audits (unchanged conclusions):**

- [2026-11-15_bug18_revolut_incremental_auth_failure_audit.md](./2026-11-15_bug18_revolut_incremental_auth_failure_audit.md)
- [2026-11-15_bug18_increment_rejection_focus.md](./2026-11-15_bug18_increment_rejection_focus.md)

**Pins at resume (supersede audit-time pins where advanced):**

| Surface | Tip / pin |
| --- | --- |
| Backend | `df12f769` (includes Bug #27 Edge `scheduled-ride-action` v592) |
| Customer | `6af35fc` (Bug #25 — trip-mod decline draft discard) |
| Driver | `0d8a5f2` (Bug #27; ancestor Bug #26 `f5b55a7`) |

Incremental-auth **policy locks** and Bug #25 recovery are **preserve** — not reopened by this plan.

---

## 1. What is already closed / locked

| Area | Status |
| --- | --- |
| Amount semantics | **CLOSED** — POST `{ amount: TARGET_TOTAL }` pence; mod payable = new fare only; buffer not re-applied on increment |
| Same-order primary path | **LOCKED** — `executeSameOrderIncrement` + `revolut-incremental-auth-primary-lock` |
| Confirm only on provider-authoritative coverage | **LOCKED** — processing/pending never counts as confirmed (MK-260915-002 class) |
| Decline → trip unchanged | **LOCKED** — payment-first gate; Bug #25 Customer draft discard on decline OK |
| Bank-decline customer copy | **LOCKED** — requires issuer-evidence match; bare `AUTHORISED_TOTAL_BELOW_TARGET` → neutral copy |
| Original hold safety | **CLOSED by evidence** — declined mods leave prior authorised total; completions capture original payable |
| Order setup for increments | **CLOSED** — manual + pre_authorisation; Revolut accepts increment POST then issuer-declines |
| Apple Pay “unsupported” hypothesis | **REFUTED** — confirmed Apple Pay increments exist |
| ONECAB math / double-buffer / delta-as-amount bugs | **REFUTED** as root cause of historical declines |

---

## 2. What remains open (true residual)

| Gap | Why it blocks closure |
| --- | --- |
| **Issuer / network reason codes** | Production rows often have `provider_decline_reason` / Revolut `reason` = **null** even when `increment_state=declined` |
| **Scheme / brand telemetry** | Visa vs Mastercard / debit vs credit not reliably queryable on declined historical rows |
| **Revolut Merchant Support** | Dashboard/support retrieve for order IDs in the rejection-focus doc still required for opaque declines |
| **Product policy when issuer declines** | Current fail-closed + unchanged trip is correct financially; clearer neutral copy / optional authenticated top-up / larger buffer are **product decisions**, not proven code bugs |
| **Google Pay trip-mod samples** | Zero production increment samples — no Google Pay-specific claim |

**Not open as a deploy-required “fix declines” bug:** issuer soft-declines with prior hold intact are expected Revolut behaviour when the underlying card rejects the increment.

---

## 3. RCA delta since original audits

No material change to the financial root cause. Since the audits:

- Bugs **#25–#27** shipped (Customer decline UX, Driver scheduled latency/banner) — **orthogonal** to increment issuer declines.
- Evidence SSOT already persists allow-listed fields (`provider_increment_state`, `provider_increment_reason`, `provider_evidence`, trail) via [`revolutIncrementEvidenceSSOT.ts`](../../supabase/functions/_shared/revolutIncrementEvidenceSSOT.ts) / [`executeSameOrderIncrementSSOT.ts`](../../supabase/functions/_shared/executeSameOrderIncrementSSOT.ts). Gap is **Revolut returning empty reason**, plus optional enrichment (scheme/brand) if the Merchant retrieve payload contains it and we currently drop it.

---

## 4. Proposed permanent fix scope (awaiting approval)

Ordered by value / risk. Implement **only** after explicit approval of which items.

### Tier A — Observability (engineering, low policy risk)

1. **Enrich redacted increment evidence** on every attempt: when Revolut retrieve includes scheme / `card_brand` / wallet type / increment id, persist allow-listed scalars into `payment_session_authorisations.metadata` (never PAN/token).  
2. **Ops runbook:** open Revolut Merchant Support with the four order IDs from the rejection-focus doc (MK-261108-001, MK-260917-010, MK-260916-041, MK-260916-027) and request issuer/network codes.  
3. **Lock tests** for any new evidence fields (absence of PII; null-safe; does not map null reason → bank-decline or insufficient funds).

### Tier B — Customer clarity (product + copy, no payment-path change)

4. When decline evidence is `provider_increment_declined` **and** issuer reason is null, ensure Customer sees **neutral hold-not-raised / trip unchanged** copy (already intended by unified bank-decline lock) — audit live strings only; change copy only if a gap is found.  
5. Do **not** offer “Choose another card” mid-mod (forbidden by unified bank-decline + same-order increment locks).

### Tier C — Policy alternatives (explicit product approval required)

6. Larger initial preauth buffer (SA `service_area_preauth_settings`) to reduce increment frequency.  
7. Controlled customer-present top-up / second checkout for shortfall (`allowControlledFallback` today **false** for mods) — only if product accepts a second payment instrument path.  
8. Do **not** change target-total semantics, create a second preauth by default, or treat `persist_failed` as issuer decline.

### Explicit non-goals (unless separately approved)

- Claiming insufficient funds without issuer evidence  
- Re-enabling Live Trip fanout / store submissions as part of B7  
- Driver OTA for payment-path changes (Customer/Edge only if Tier A/B ship)

---

## 5. Recommended approval ask

Approve **Tier A** (evidence enrichment + Revolut support ticket) as the next implementable slice. Hold Tier B/C until support returns codes or product decides buffer/top-up policy.

Suggested implement gate after approval:

1. Code + lock tests for evidence enrichment only.  
2. Deploy only affected Edge functions that write increment metadata (likely `update-preauth-on-trip-modification` / shared modules already bundled).  
3. No Customer OTA unless Tier B copy gap is proven.  
4. No paid test bookings unless you request them.

---

## 6. Other deferred streams (parked)

| ID | Item | Action until B7 closes or you re-prioritise |
| --- | --- | --- |
| B8 | MK0006 Luton airport acceptance | Parked |
| B9 | Live Trip packaging (fanout off) | Parked |
| B10 | Android versionCode / next binary | Parked (store still paused) |
| B12 | Play recommendations | Parked |

---

## 7. Stop line

**Awaiting your explicit approval** before any implement, Edge deploy, OTA, SQL, SA buffer change, or Revolut support ticket filing from this agent.
