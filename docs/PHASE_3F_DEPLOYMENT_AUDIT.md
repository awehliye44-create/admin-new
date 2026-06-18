# Phase 3F — Deployment Audit

**Date:** 2026-06-18  
**Project:** `thazislrdkjpvvghtvzo` (prod)  
**Repo:** `admin-new` (+ related apps noted below)  
**Status:** **COMPLETE** — see [`phase3f-completion-proof.json`](phase3f-completion-proof.json) and [`PHASE_3F_COMPLETION_REPORT.md`](PHASE_3F_COMPLETION_REPORT.md)  
**Mode:** Audit and verification complete — no Stripe changes, ledger writes, or execution-flag changes during this phase

---

## Executive summary

Production **already reflects** the verified Phase 3D finance baseline for database migrations (3C.5–3D.3) and critical edge functions (3D.1 gates, Connect lockdown). Phase 3D.4 closure verification **re-passed** on 2026-06-18 with 9/9 sections PASS.

**Deployment gap (resolved 2026-06-18):** Git baseline committed (`d6b7df0`), tagged `ONECAB_FINANCE_BASELINE_v1`, pushed to GitHub. **Remaining:** Lovable manual Publish for Admin UI.

| Area | Prod state | Local state | Deploy needed? |
|------|------------|-------------|----------------|
| Finance DB (3C.5–3D.3) | Applied | Matches | **No** (baseline frozen) |
| Payout edge functions (3D.1, 3D.3) | Deployed v181/v6/v145 | Uncommitted diffs | **Verify parity** before tag |
| Read-only audit functions | Deployed | Matches | **No** |
| Admin UI (finance pages) | Partial (pre-3E) | Full 3C–3E UI | **Yes** |
| Driver app | Separate repo | Out of scope | **No** (wallet edges deployed) |
| Passenger app | `onecab-comfy-ride` | Separate | **No** for finance baseline |
| 3 local-only migrations | Not in remote history | Present locally | **Review §2** |

**Overall deploy safety for baseline freeze:** **CONDITIONAL GO** — safe to publish Admin UI and commit/tag git; **do not** enable payout execution.

---

## 1. Deployment matrix

### 1.1 Edge functions

| Component | Local | Prod | Version (prod) | Updated (UTC) | Needs deploy |
|-----------|-------|------|----------------|---------------|--------------|
| `admin-driver-payout` | Modified (+512 LOC uncommitted) | Deployed | **v181** | 2026-06-18 10:54 | **Verify** — prod likely matches 3D.1; git not tagged |
| `admin-weekly-monday-settlement` | Untracked dir / new | Deployed | **v6** | 2026-06-18 10:53 | **No** |
| `admin-connect-payout-status` | Untracked | Deployed | **v2** | 2026-06-18 11:52 | **No** |
| `admin-connect-payout-lockdown` | Untracked | Deployed | **v2** | 2026-06-18 11:52 | **No** |
| `stripe-onboard-driver` | Modified (+28 LOC) | Deployed | **v145** | 2026-06-18 11:51 | **No** (manual schedule live) |
| `stripe-reconciliation-audit` | Untracked | Deployed | **v2** | 2026-06-18 09:07 | **No** |
| `phase-3d2-stripe-balance-audit` | Untracked | Deployed | **v1** | 2026-06-18 11:14 | **No** |
| `phase-3d3a-future-payout-probe` | Untracked | Deployed | **v1** | 2026-06-18 11:44 | **No** |
| `stripe-connected-balance-tx` | Untracked | Deployed | **v2** | 2026-06-18 09:08 | **No** |
| `admin-monday-payout-diagnostics` | Modified (shared deps) | Deployed | **v6** | 2026-06-18 10:05 | **Optional** — if shared lib drift |
| `admin-finance-reconciliation` | Modified (shared SSOT) | Deployed | **v23** | 2026-06-16 14:07 | **Optional** — re-deploy if SSOT formulas changed locally |
| `finance-backend-audit-v1` | Modified (shared) | Deployed | **v13** | 2026-06-16 19:22 | **Optional** |
| `admin-sync-payout-ledger` | Unchanged | Deployed | **v12** | 2026-06-12 21:24 | **No** |
| `admin-payout-batches` | Unchanged | Deployed | **v180** | 2026-06-12 21:24 | **No** |
| `capture-trip-payment` | Modified (+2 LOC) | Deployed | (older) | 2026-06-12+ | **Low priority** — not payout path |
| `admin-edit-trip-fare` | Modified (+84 LOC) | Deployed | **v34** | 2026-06-12 11:42 | **Separate** — trip fare, not baseline freeze |
| `driver-wallet-summary` | N/A (driver edge) | Deployed | **v305** | 2026-06-17 06:25 | **No** |
| `driver-wallet-transactions` | N/A | Deployed | **v284** | 2026-06-17 12:12 | **No** |

**Shared libraries** (bundled on function deploy — not standalone):

| Module | Local status | Prod effective | Needs redeploy trigger |
|--------|--------------|----------------|------------------------|
| `_shared/payoutExecutionGate.ts` | Untracked | Via v181/v6 | **No** if v181/v6 current |
| `_shared/connectPayoutLockdown.ts` | Untracked | Via connect fns v2 | **No** |
| `_shared/financialReconciliationSSOT.ts` | Modified (−458/+ refactor) | Via finance fns | **Optional** batch redeploy |
| `_shared/perDriverFinancialReconciliation.ts` | Modified | Via finance fns | **Optional** |
| `_shared/walletBalanceSSOT.ts` | Modified | Via finance fns | **Optional** |
| `_shared/onecabFinanceLedger.ts` | Modified | Via finance fns | **Optional** |
| `_shared/payoutFailureRecovery.ts` | Modified | Via admin-driver-payout | **Verify with v181** |
| `_shared/mondayPayoutDiagnostics.ts` | Modified | Via diagnostics v6 | **Optional** |

### 1.2 Admin UI (`admin-new` → Lovable / static host)

| Component | Local | Prod (hosted) | Needs deploy |
|-----------|-------|---------------|--------------|
| `ConnectPayoutLockdown.tsx` + route | **New (untracked)** | Missing | **Yes** |
| `ManualPayoutConfirmDialog.tsx` | **New** | Missing | **Yes** |
| `WeeklyMondaySettlementPanel.tsx` | **New** | Missing | **Yes** |
| `manualPayoutGate.ts` + tests | **New** | Missing | **Yes** |
| `useConnectPayoutStatus.ts` | **New** | Missing | **Yes** |
| `AdminDriverSettlements.tsx` | Modified (+120 LOC) | Stale | **Yes** |
| `DriverSSOTPayoutPanel.tsx` | Modified (+113 LOC) | Stale | **Yes** |
| `DriverWallet.tsx` | Modified | Stale | **Yes** |
| `AdminPayoutBatches.tsx` | Modified | Stale | **Yes** |
| `App.tsx` + `AdminSidebar.tsx` | Modified (Connect route) | Stale | **Yes** |
| `RolesPermissions.tsx` | Modified (connect-payout page) | Stale | **Yes** |
| Finance reconciliation pages | Partial | Partial | **Yes** (SSOT panels) |

**Deploy method:** Lovable publish (`admin-lovable-publish` edge) or CI `vite build` → host. **No payout execution** in UI deploy.

### 1.3 Driver app

| Component | Local | Prod | Needs deploy |
|-----------|-------|------|--------------|
| Mobile driver app repo | **Not in `admin-new`** (separate codebase) | Live via app stores / Capacitor | **No** for 3F baseline |
| `driver-wallet-summary` edge | N/A | v305 | **No** |
| `driver-stripe-onboard` edge | N/A | v286 | **No** |

Wallet SSOT verified via edge + DB — driver app reads `driver-wallet-summary`; no driver-app code changes required for finance baseline freeze.

### 1.4 Passenger / customer app

| Component | Local | Prod | Needs deploy |
|-----------|-------|------|--------------|
| `onecab-comfy-ride` | Separate repo; local changes unrelated to finance baseline | Live | **No** |
| Trip capture / payment edges | `capture-trip-payment` minor local diff | Deployed | **Out of scope** for 3F |

### 1.5 SQL migrations

| Migration | Local file | Remote applied | Needs deploy |
|-----------|------------|----------------|--------------|
| `20260715120000` p0_finance_ledger_ssot | Yes | **Yes** | **No** |
| `20260718120000` phase_3c5_priority_fixes | Yes | **Yes** | **No** |
| `20260718130000` phase_3c6_mk0002_option3 | Yes | **Yes** | **No** |
| `20260719120000` phase_3d1_orphan_cancel | Yes | **Yes** | **No** |
| `20260720120000` phase_3d3_connect_lockdown | Yes | **Yes** | **No** |
| `20260618120000` phase_3c4_admin_wallet_ssot | Yes | **No** (local-only in history) | **See §2** |
| `20260616075018` security/RLS hardening | Yes | **No** | **See §2** |
| `20260616161708` corporate payment methods | Yes | **No** | **See §2** |

**Note:** `driver_financial_summary` view **exists** on prod and wallet SSOT passes — 3C.4 view logic may have been applied via equivalent path or manual query. Migration history row for `20260618120000` is still missing.

### 1.6 Verification scripts & docs (local only)

| Artifact | Deployed? | Action |
|----------|-----------|--------|
| `scripts/phase3d4-finance-closure-verification.ts` | N/A (CLI) | Commit to repo |
| `scripts/phase3d1-payout-safety-verification.ts` | N/A | Commit |
| `scripts/phase3d3-connect-lockdown-verification.ts` | N/A | Commit |
| Phase 3A–3E docs (`docs/PHASE_3*.md`) | N/A | Commit for baseline tag |

---

## 2. Safe migration audit

### 2.1 Unapplied migrations (local → remote)

| Migration | Summary | Classification | Rationale |
|-----------|---------|----------------|-----------|
| `20260618120000_phase_3c4_admin_wallet_ssot_alignment.sql` | Recreates `driver_financial_summary` view; wallet SSOT alignment | **REQUIRES BACKUP** | `DROP VIEW` + recreate; finance read path. Prod view works today — apply only after diff review vs live view |
| `20260616075018_…sql` | RLS on invoice sequences; security_invoker; payout_audit_log policy | **SAFE** | Additive RLS/policies; no data mutation |
| `20260616161708_…sql` | Corporate account payment method columns + function | **SAFE** | Additive columns with defaults; not finance payout path |

### 2.2 Already applied finance baseline migrations (do not re-apply)

| Order | Migration | Purpose |
|-------|-----------|---------|
| 1 | `20260715120000_p0_finance_ledger_ssot.sql` | Ledger SSOT enums, INVALID_ORPHANED |
| 2 | `20260718120000_phase_3c5_priority_fixes.sql` | FAILED_DUPLICATE, duplicate item fix |
| 3 | `20260718130000_phase_3c6_mk0002_option3_remediation.sql` | MK0002 partial debit + recon note |
| 4 | `20260719120000_phase_3d1_orphan_weekly_cancel.sql` | Orphan batch/item cancel |
| 5 | `20260720120000_phase_3d3_connect_payout_lockdown.sql` | Connect audit table |

### 2.3 Migration history drift (remote-only entries)

Remote migration history contains **~20+ version timestamps** not present as local files (e.g. `20260615210000`, `20260630120000`, Lovable-generated UUID migrations). These were applied on prod from other branches or dashboard.

| Classification | Action |
|----------------|--------|
| **DO NOT DEPLOY** (blind `supabase db push`) | Full push from local may fail or conflict |
| **REQUIRES MAINTENANCE WINDOW** | `supabase db pull` to reconcile history before Phase 4 |
| **Safe path for 3F** | Leave prod DB as-is; repair history only for new migrations |

### 2.4 Recommended deployment order (when executing — not in 3F)

```
1. Pre-deploy: Supabase backup / PITR checkpoint (§3)
2. Commit + tag git baseline (§5)
3. Apply SAFE migrations: 20260616075018 → 20260616161708
4. Review + apply 20260618120000 only if view diff differs from prod
5. Deploy Admin UI (read-only pages first)
6. Optional: batch redeploy finance edge functions if SSOT shared code committed
7. Post-deploy: phase3d4-finance-closure-verification.ts (read-only)
8. Confirm ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=false
```

**DO NOT DEPLOY in baseline window:**

- Any migration enabling payout execution
- Any data-fix migration without Ahmed approval
- Destructive ledger/payout batch mutations

---

## 3. Production backup check

### 3.1 Database backups

| Item | Status | Notes |
|------|--------|-------|
| Supabase automated backups | **Assumed enabled** (Pro plan — Frankfurt) | Verify in [Supabase Dashboard → Database → Backups](https://supabase.com/dashboard/project/thazislrdkjpvvghtvzo/database/backups) |
| Point-in-time recovery (PITR) | **Verify in dashboard** | Required before applying `20260618120000` view recreate |
| Manual pre-migration snapshot | **Recommended** | `pg_dump` or dashboard backup before any future migration |

### 3.2 Recovery procedure

1. **Minor rollback (migration):** Restore from PITR to timestamp before migration window (Supabase support / dashboard).
2. **Edge function rollback:** Redeploy prior function version via Supabase CLI `--version` history or redeploy from git tag.
3. **Admin UI rollback:** Re-publish prior Lovable deployment.
4. **Finance data integrity:** Never delete ledger rows; use reversal entries only per Phase 3E runbook.

### 3.3 Rollback strategy (non-destructive)

| Change type | Rollback |
|-------------|----------|
| Edge function deploy | Redeploy previous version from git tag |
| Admin UI publish | Lovable rollback to prior publish |
| SAFE migration (RLS) | Drop added policies if needed — low risk |
| View migration (3C.4) | Keep previous view definition in migration file for manual restore |
| Connect lockdown | Do **not** revert to automatic — manual is policy |
| Execution secret | Set `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=false` immediately |

### 3.4 Migration rollback notes

| Migration | Rollback complexity |
|-----------|---------------------|
| `20260720120000` (audit table) | Low — table can remain; no rollback required for freeze |
| `20260719120000` (orphan cancel) | **Do not rollback** — would restore orphan execution risk |
| `20260718130000` (MK0002 debit) | **Do not rollback** — ledger integrity |
| `20260618120000` (view) | Medium — restore prior `CREATE VIEW` from git history |

**3F constraint honoured:** No backup restore or migration executed during this audit.

---

## 4. Edge function deployment plan

### 4.1 Functions frozen on prod (no redeploy required for baseline)

These match verified Phase 3D behaviour:

- `admin-driver-payout` v181 — 3D.1 gates, `payout_safety_version: 3d.1`
- `admin-weekly-monday-settlement` v6
- `admin-connect-payout-status` v2 / `admin-connect-payout-lockdown` v2
- `stripe-onboard-driver` v145 — manual Connect default
- Read-only audits: `phase-3d2-*`, `phase-3d3a-*`, `stripe-reconciliation-audit`

### 4.2 Pre-deploy verification checklist (every function deploy)

| Check | Command / method |
|-------|------------------|
| Execution flag false | Supabase secrets — **do not change in 3F** |
| Dry-run manual payout | `admin-driver-payout { verification_mode: true }` |
| Dry-run weekly | `admin-weekly-monday-settlement { verification_mode: true }` |
| Connect manual | `admin-connect-payout-status` → `automatic_count: 0` |
| No ledger delta | Compare `driver_wallet_ledger` count before/after dry-runs |

### 4.3 Optional batch redeploy (post git commit only)

If shared SSOT modules are committed and differ from prod v23/v13:

```bash
# Planning reference only — do not run in 3F without approval
supabase functions deploy admin-finance-reconciliation finance-backend-audit-v1 \
  admin-monday-payout-diagnostics admin-finance-settlement-summary \
  --project-ref thazislrdkjpvvghtvzo
```

**Verify after any deploy:** `npx tsx scripts/phase3d4-finance-closure-verification.ts`

### 4.4 Functions that must NOT be deployed with execution enabled

- `admin-driver-payout`
- `admin-weekly-monday-settlement`
- `admin-sync-payout-ledger` (orphan discover writes ledger — ops-only)

---

## 5. Git & release state

| Item | Value |
|------|-------|
| Branch | `main` |
| HEAD commit | `5356720` — `fix(finance): align driver wallet cache with ledger SSOT` |
| Uncommitted changes | **29 modified** + **~59 untracked** (finance 3C–3E work) |
| Remote tracking | Verify `git remote -v` before tag push |

**Critical gap:** Verified prod baseline was achieved via **direct prod deploys + `db query -f`** during Phase 3D; git HEAD does not yet capture the full baseline.

**Required before tag:** Single commit (or squashed series) containing all Phase 3C–3F artifacts.

---

## 6. Open finance blockers (unchanged by deploy)

| Blocker | Blocks live payout | Blocks baseline tag |
|---------|-------------------|---------------------|
| `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=false` | Yes (intentional) | **No** |
| MK0001 wallet −£2.78 | Yes | **No** |
| MK0002 wallet −£23.00 + RECONCILIATION_MISMATCH | Yes | **No** |
| Region Driver Available Now £0 | Yes | **No** |
| Ahmed first-payout approval | Yes | **No** |
| Git uncommitted baseline | **No** (ops risk) | **Yes** — tag incomplete |
| Admin UI not published | **No** (ops visibility) | **Yes** — partial operator experience |
| 3 local-only migrations | **No** (prod passes SSOT) | **Yes** — history hygiene |

---

## 7. Final Go / No-Go

### Is production safe **as it sits today**?

| Question | Verdict | Evidence |
|----------|---------|----------|
| Finance baseline verified? | **GO** | Phase 3D.4 — 9/9 PASS (2026-06-18 re-run) |
| Payout execution disabled? | **GO** | 3D.1 dry-runs — zero side effects |
| Connect lockdown active? | **GO** | `automatic_count: 0` |
| Safe for **new Phase 4 development** to start? | **CONDITIONAL GO** | After git commit + Admin UI publish (read-only) |

### Is it safe to **deploy** remaining local changes?

| Deploy target | Verdict |
|---------------|---------|
| Admin UI (finance pages) | **GO** — read-only visibility; no execution toggle in UI |
| SAFE migrations (RLS, corporate) | **GO** — with backup checkpoint |
| `20260618120000` view migration | **CONDITIONAL** — diff live view first |
| Edge function batch redeploy | **CONDITIONAL** — only after git commit; verify with 3D.4 script |
| Enable payout execution | **NO-GO** | Phase 3E gate not satisfied |

### Are migrations safe?

| Set | Verdict |
|-----|---------|
| Already-applied 3C.5–3D.3 | **GO** — verified in prod |
| Pending SAFE (2 migrations) | **GO** with backup |
| Pending 3C.4 view | **CONDITIONAL** |
| Full `db push` from local | **NO-GO** — history drift |

---

## 8. Recommended immediate actions (Phase 3F execution — separate approval)

1. **Commit** all Phase 3C–3F code, migrations, scripts, and docs to `admin-new`.
2. **Publish** Admin UI to Lovable (finance + Connect lockdown pages).
3. **Tag** `ONECAB_FINANCE_BASELINE_v1` at commit (see release baseline doc).
4. **Apply** SAFE migrations `20260616075018`, `20260616161708` in maintenance window with backup.
5. **Reconcile** migration history drift before Phase 4 schema work.
6. **Leave** `ADMIN_PAYOUT_STRIPE_EXECUTION_ENABLED=false`.

---

## Stop condition

This audit is **read-only planning**. No Stripe changes, ledger writes, deployments, or execution-flag modifications were performed.

**Companion doc:** [`PHASE_3F_RELEASE_BASELINE.md`](PHASE_3F_RELEASE_BASELINE.md)
