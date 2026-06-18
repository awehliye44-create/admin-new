# ONECAB Finance Baseline — Release Baseline v1

**Release name:** `ONECAB_FINANCE_BASELINE_v1`  
**Date:** 2026-06-18  
**Project:** `thazislrdkjpvvghtvzo` (Supabase prod, Frankfurt)  
**Region scope:** MK (`7f611e59-a9e5-42c2-b65a-61376910bb5d`)  
**Status:** **COMPLETE** — tag `ONECAB_FINANCE_BASELINE_v1` on `d6b7df0` (2026-06-18)

### Phase 3F completion proof (2026-06-18)

| Check | Result | Evidence |
|-------|--------|----------|
| Git baseline pushed | **PASS** | `d6b7df0` on `origin/main` |
| Release tag | **PASS** | `ONECAB_FINANCE_BASELINE_v1` pushed |
| `npm run build` | **PASS** | 6.65s, `dist/` produced |
| Phase 3D.4 verification | **PASS** | 9/9 sections |
| Phase 3D.1 payout safety | **PASS** | zero side effects |
| Phase 3D.3 Connect lockdown | **PASS** | `automatic_count: 0`, `ledger_delta: 0` |
| Unit tests (payout gate) | **PASS** | 9/9 |
| Stripe writes during audit | **NONE** | read-only + verification_mode only |
| Ledger writes during audit | **NONE** | `ledger_delta: 0` |
| Execution flag | **false** | verified via dry-run responses |
| Lovable git sync | **PASS** | manual Publish still required in Lovable UI |

Full JSON: [`phase3f-completion-proof.json`](phase3f-completion-proof.json)

---

## Release summary

This release marks the **frozen finance investigation baseline** completing Phases 3A through 3E:

| Phase | Scope | Status |
|-------|-------|--------|
| 3A | Wallet SSOT / ledger liability | Complete |
| 3B | Financial reconciliation SSOT | Complete |
| 3C | Stripe reconciliation, orphan remediation, payout gates (3C.3e) | Complete |
| 3D | Payout safety lockdown, Connect manual lockdown, finance closure | Complete |
| 3E | Production payout operations readiness (planning) | Complete |

**Finance closure verification:** **PASS** (9/9 sections)  
**First controlled live payout:** **NO-GO** (by design — execution disabled)

---

## Tag recommendation

```bash
# After committing full working tree to admin-new main:
git tag -a ONECAB_FINANCE_BASELINE_v1 -m "$(cat <<'EOF'
ONECAB finance baseline v1 — Phases 3A–3E complete.

Verified: wallet SSOT, reconciliation SSOT, Stripe audit, Connect manual
lockdown, payout safety gates 3D.1, orphan cleanup, finance closure PASS.

Payout execution: DISABLED (ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=false).
First live payout: NO-GO per Phase 3E.

Prod: thazislrdkjpvvghtvzo
EOF
)"
git push origin ONECAB_FINANCE_BASELINE_v1
```

### Commit references

| Reference | SHA / state | Role |
|-----------|-------------|------|
| **Partial git baseline** | `5356720` | Last commit on `main` — wallet cache alignment |
| **Recommended tag target** | *Pending commit* | Must include all 3C–3F uncommitted files (~88 paths) |
| **Prod-verified state** | Deployed 2026-06-18 | Edge v181/v6/v145 + migrations through `20260720120000` |

**Important:** Production was verified **after** direct deploys that exceed git HEAD `5356720`. The tag MUST point to a commit that includes at least:

- `supabase/functions/admin-driver-payout/` (3D.1 gates)
- `supabase/functions/admin-weekly-monday-settlement/`
- `supabase/functions/_shared/payoutExecutionGate.ts`
- `supabase/functions/_shared/connectPayoutLockdown.ts`
- `supabase/functions/admin-connect-payout-*`
- `supabase/migrations/20260715120000` through `20260720120000`
- `scripts/phase3d4-finance-closure-verification.ts`
- `docs/PHASE_3D4_*` through `docs/PHASE_3F_*`

---

## Migration references

### Applied on prod (finance baseline — frozen)

| Migration ID | File | Phase | Applied |
|--------------|------|-------|---------|
| `20260715120000` | `p0_finance_ledger_ssot.sql` | 3C P0 | ✅ |
| `20260718120000` | `phase_3c5_priority_fixes.sql` | 3C.5 | ✅ |
| `20260718130000` | `phase_3c6_mk0002_option3_remediation.sql` | 3C.6 | ✅ |
| `20260719120000` | `phase_3d1_orphan_weekly_cancel.sql` | 3D.1 | ✅ |
| `20260720120000` | `phase_3d3_connect_payout_lockdown.sql` | 3D.3 | ✅ |

### Pending (not in remote migration history)

| Migration ID | File | Phase | Tag note |
|--------------|------|-------|----------|
| `20260618120000` | `phase_3c4_admin_wallet_ssot_alignment.sql` | 3C.4 | Include in repo; apply separately after view diff |
| `20260616075018` | RLS / security hardening | Infra | SAFE — post-tag optional |
| `20260616161708` | Corporate payment methods | Corporate | SAFE — post-tag optional |

---

## Deployed edge functions (prod snapshot 2026-06-18)

### Payout & safety (frozen)

| Function | Version | Deployed (UTC) | Gate / behaviour |
|----------|---------|----------------|------------------|
| `admin-driver-payout` | **181** | 2026-06-18 10:54 | 3D.1 — `verification_mode` early exit; execution secret required |
| `admin-weekly-monday-settlement` | **6** | 2026-06-18 10:53 | 3D.1 — same gate |
| `admin-sync-payout-ledger` | **12** | 2026-06-12 21:24 | Ledger sync / orphan discover (ops) |
| `admin-monday-payout-diagnostics` | **6** | 2026-06-18 10:05 | Read-only diagnostics |

### Connect lockdown (frozen)

| Function | Version | Deployed (UTC) |
|----------|---------|----------------|
| `admin-connect-payout-status` | **2** | 2026-06-18 11:52 |
| `admin-connect-payout-lockdown` | **2** | 2026-06-18 11:52 |
| `stripe-onboard-driver` | **145** | 2026-06-18 11:51 |

### Finance SSOT & audit (read-only)

| Function | Version | Deployed (UTC) |
|----------|---------|----------------|
| `admin-finance-reconciliation` | **23** | 2026-06-16 14:07 |
| `finance-backend-audit-v1` | **13** | 2026-06-16 19:22 |
| `finance-reconciliation-driver` | **14** | 2026-06-17 10:25 |
| `stripe-reconciliation-audit` | **2** | 2026-06-18 09:07 |
| `phase-3d2-stripe-balance-audit` | **1** | 2026-06-18 11:14 |
| `phase-3d3a-future-payout-probe` | **1** | 2026-06-18 11:44 |
| `stripe-connected-balance-tx` | **2** | 2026-06-18 09:08 |

### Driver wallet (consumer edges — unchanged baseline)

| Function | Version | Deployed (UTC) |
|----------|---------|----------------|
| `driver-wallet-summary` | **305** | 2026-06-17 06:25 |
| `driver-wallet-transactions` | **284** | 2026-06-17 12:12 |

---

## Admin UI baseline (pending publish)

Included in tag commit; **requires Lovable publish** to match prod operator experience:

| Page / component | Route / location |
|------------------|------------------|
| Connect Payout Lockdown | `/connect-payout-lockdown` |
| Manual Payout Confirm Dialog | Driver Settlements |
| Weekly Monday Settlement Panel | Driver Settlements |
| SSOT payout panels | Driver Settlements, Driver Wallet |
| Payout Batches & Audit | `/payout-batches` |
| Financial Reconciliation | `/financial-reconciliation` |

---

## Configuration secrets (frozen state)

| Secret | Required value at baseline | Mutable by |
|--------|---------------------------|------------|
| `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED` | **`false`** | Super Admin + Ahmed approval only |
| `STRIPE_SECRET_KEY` | Set (prod) | No change in 3F |
| `SUPABASE_SERVICE_ROLE_KEY` | Set | No change in 3F |

**Connect payout schedule (Stripe):** MK0001 + MK0002 = **`manual`** (applied 2026-06-18, LOCKDOWN_APPLIED audit rows).

---

## Verification reports (evidence bundle)

| Report | Path | Result |
|--------|------|--------|
| Phase 3D.4 Finance Closure | `docs/PHASE_3D4_FINANCE_CLOSURE_FINAL_VERIFICATION.md` | **PASS** 9/9 |
| Phase 3D.4 JSON evidence | `docs/phase3d4-verification-output.json` | 9/9 sections |
| Phase 3D.1 Payout Safety | `docs/PHASE_3D1_PAYOUT_SAFETY_LOCKDOWN_REPORT.md` | Gates deployed |
| Phase 3D.1 JSON | `docs/phase3d1-verification-output.json` | PASS |
| Phase 3D.3 Connect Lockdown | `docs/PHASE_3D3_CONNECT_AUTO_PAYOUT_LOCKDOWN_REPORT.md` | Manual applied |
| Phase 3D.3 JSON | `docs/phase3d3-verification-output.json` | PASS |
| Phase 3D.2 Provider Available | `docs/PHASE_3D2_PROVIDER_AVAILABLE_AUDIT.md` | Documented |
| Phase 3D.2 Stripe Balance | `docs/PHASE_3D2_STRIPE_BALANCE_AUDIT.md` | Documented |
| Phase 3E Ops Readiness | `docs/PHASE_3E_PRODUCTION_PAYOUT_READINESS_PLAN.md` | Planning complete |
| Phase 3F Deployment Audit | `docs/PHASE_3F_DEPLOYMENT_AUDIT.md` | This release prep |

### Re-run verification (any time)

```bash
cd admin-new
set -a && source .env && set +a
npx tsx scripts/phase3d4-finance-closure-verification.ts
npx tsx scripts/phase3d1-payout-safety-verification.ts
npx tsx scripts/phase3d3-connect-lockdown-verification.ts  # no apply flag
```

---

## Prod financial snapshot at baseline

| Metric | Value (2026-06-18) |
|--------|-------------------|
| MK0001 wallet (ledger SSOT) | **−£2.78** |
| MK0002 wallet (ledger SSOT) | **−£23.00** |
| Region aggregate wallet | **−£25.78** |
| Provider Available (platform) | **£6.66** |
| Platform pending (incoming) | **£1.13** |
| Region Driver Available Now | **£0.00** |
| Connect accounts on manual | **2 / 2** |
| Payout execution | **Disabled** |

---

## Release criteria checklist

| Criterion | Met? |
|-----------|------|
| Wallet SSOT PASS | ✅ |
| Financial Reconciliation SSOT PASS | ✅ |
| Stripe Reconciliation PASS | ✅ |
| Connect Auto-Payout Lockdown PASS | ✅ |
| Payout Safety Gates PASS | ✅ |
| Orphan / Duplicate Cleanup PASS | ✅ |
| Finance Closure PASS | ✅ |
| Phase 3E ops plan documented | ✅ |
| Git commit contains full baseline | ✅ `d6b7df0` |
| Admin UI published | ⚠️ **Git pushed** — Lovable manual Publish still required |
| Release tag created | ✅ `ONECAB_FINANCE_BASELINE_v1` |
| Payout execution enabled | ❌ **Must remain false** |

---

## Go / No-Go matrix

| Decision | Verdict |
|----------|---------|
| **Tag `ONECAB_FINANCE_BASELINE_v1` after commit** | **GO** |
| **Publish Admin UI (no execution)** | **GO** |
| **Start Phase 4A–4F development** | **GO** after tag + UI publish |
| **Apply pending SAFE migrations** | **GO** with backup |
| **Enable payout execution** | **NO-GO** |
| **First controlled live payout** | **NO-GO** |

---

## Known limitations at v1

1. **Migration history drift** — remote-only migration timestamps exist; full `db push` unsafe until reconciled.
2. **3C.4 migration** — view logic live on prod but history row `20260618120000` not recorded.
3. **Negative driver wallets** — operational state documented; not a blocker for baseline tag.
4. **MK0002 RECONCILIATION_MISMATCH** — payout correctly blocked; remediation deferred to Phase 4+.
5. **Historical Stripe orphans** — documented in 3C.4/3C.5; backfills applied where approved.
6. **Driver / passenger mobile apps** — separate repos; not part of this tag.

---

## Post-tag operator instructions

1. Treat **`ONECAB_FINANCE_BASELINE_v1`** as the read-only finance reference point.
2. Run **3D.4 verification** weekly (Phase 3E schedule).
3. Do **not** set `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=true` without Phase 3E §6 gate clearance.
4. Branch Phase 4 work from tagged commit; finance hotfixes cherry-pick to `main` with re-verification.

---

## Stop condition

Release baseline document complete. No deployments, Stripe mutations, ledger writes, or secret changes were made during Phase 3F.

**Previous:** Phase 3E Production Payout Readiness Plan  
**Next (recommended):** Git commit → tag → Admin UI publish → Phase 4A kickoff
