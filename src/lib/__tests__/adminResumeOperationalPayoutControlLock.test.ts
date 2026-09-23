/**
 * Safe Resume operational-pause control locks (Admin draft).
 * Covers UI wiring, migration resume gates, and MK0007 £15.26 classification.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computeFrDriverReconciliation,
  buildPeriodScopedFrDriverInputs,
} from '../../../supabase/functions/_shared/frDriverReconciliationSSOT.ts';
import { buildFrDriverSettlementTripRow } from '../../../supabase/functions/_shared/frDriverExpectedEntitlementSSOT.ts';
import {
  operationalPauseConfirmCopy,
  validateOperationalPauseReason,
} from '../adminSetDriverPayoutOperationalPause';

const ROOT = resolve(__dirname, '../../..');
const FWD = resolve(
  ROOT,
  'supabase/migrations/20261127140000_admin_resume_payout_operational_pause_gates.sql',
);
const CLIENT = resolve(ROOT, 'src/lib/adminSetDriverPayoutOperationalPause.ts');
const LEDGER = resolve(ROOT, 'src/pages/PayoutLedger.tsx');
const SETTINGS = resolve(ROOT, 'src/components/finance/PayoutLedgerSettingsPanel.tsx');
const STAGE_C = resolve(
  ROOT,
  'supabase/migrations/20261109470000_phase_a8b28f_stage_c_wallet_payout_eligibility_cutover.sql',
);

const MK0007 = {
  driverId: '56136f5f-1a3a-4a14-bb23-439b3951415a',
  trips: [
    {
      id: '7851dedd-6d52-457e-9269-44a1ac484b72',
      trip_code: 'MK-260917-012',
      completed_at: '2026-09-17T11:49:59.57Z',
      status: 'completed',
      driver_net_pence: 435,
      tip_pence: 100,
      tip_amount_pence: 100,
      financial_model: 'PLATFORM_COLLECTED',
      payment_status: 'captured',
    },
    {
      id: 'd2a5149f-3f00-4c51-9c9b-00d3f809303e',
      trip_code: 'MK-260917-014',
      completed_at: '2026-09-17T19:03:35.637Z',
      status: 'completed',
      driver_net_pence: 435,
      tip_pence: 0,
      tip_amount_pence: 0,
      financial_model: 'PLATFORM_COLLECTED',
      payment_status: 'captured',
    },
    {
      id: '25fbc3f1-7e8c-4686-ab85-e05426175d3a',
      trip_code: 'MK-260917-015',
      completed_at: '2026-09-17T19:34:48.914Z',
      status: 'completed',
      driver_net_pence: 556,
      tip_pence: 0,
      tip_amount_pence: 0,
      financial_model: 'PLATFORM_COLLECTED',
      payment_status: 'captured',
    },
  ] as const,
  sessions: {
    '7851dedd-6d52-457e-9269-44a1ac484b72': {
      status: 'captured',
      captured_at: '2026-09-17T11:50:14.15Z',
      captured_amount_pence: 600,
    },
    'd2a5149f-3f00-4c51-9c9b-00d3f809303e': {
      status: 'captured',
      captured_at: '2026-09-17T19:03:53.599Z',
      captured_amount_pence: 500,
    },
    '25fbc3f1-7e8c-4686-ab85-e05426175d3a': {
      status: 'captured',
      captured_at: '2026-09-17T19:35:23.591Z',
      captured_amount_pence: 654,
    },
  } as Record<string, Record<string, unknown>>,
  ledger: [
    {
      id: '3dbb5d27-90f6-497e-bbc8-2d7948602e00',
      type: 'TRIP_EARNING_NET',
      amount_pence: 435,
      related_trip_id: '7851dedd-6d52-457e-9269-44a1ac484b72',
      created_at: '2026-09-17T11:50:02.39279Z',
    },
    {
      id: 'c2e1f133-5809-4e56-bd7d-57b8ff95b477',
      type: 'DRIVER_TIP_CREDIT',
      amount_pence: 100,
      related_trip_id: '7851dedd-6d52-457e-9269-44a1ac484b72',
      created_at: '2026-09-17T11:50:15.309147Z',
    },
    {
      id: '5bac37f6-f213-4e60-b346-900568bd1e9a',
      type: 'TRIP_EARNING_NET',
      amount_pence: 435,
      related_trip_id: 'd2a5149f-3f00-4c51-9c9b-00d3f809303e',
      created_at: '2026-09-17T19:03:36.973717Z',
    },
    {
      id: 'b84065d9-4571-4586-8f4d-debc4918c545',
      type: 'TRIP_EARNING_NET',
      amount_pence: 556,
      related_trip_id: '25fbc3f1-7e8c-4686-ab85-e05426175d3a',
      created_at: '2026-09-17T19:34:50.59806Z',
    },
  ],
};

describe('admin resume operational payout control locks', () => {
  const fwd = readFileSync(FWD, 'utf8');
  const client = readFileSync(CLIENT, 'utf8');
  const ledgerUi = readFileSync(LEDGER, 'utf8');
  const settingsUi = readFileSync(SETTINGS, 'utf8');
  const stageC = readFileSync(STAGE_C, 'utf8');

  it('1. Resume UI calls operational-pause RPC', () => {
    expect(ledgerUi).toMatch(/adminSetDriverPayoutOperationalPause/);
    expect(ledgerUi).toMatch(/admin_set_driver_payout_operational_pause|adminSetDriverPayoutOperationalPause/);
    expect(client).toMatch(/supabase\.rpc\('admin_set_driver_payout_operational_pause'/);
    expect(operationalPauseConfirmCopy({ action: 'resume', driverName: 'Ahmed', driverCode: 'MK0007' }).body)
      .toContain('does not send money immediately');
  });

  it('2. No direct drivers.update pause/resume path remains in Admin pause surfaces', () => {
    expect(ledgerUi).not.toMatch(/\.update\(\s*\{\s*payouts_enabled/);
    expect(settingsUi).not.toMatch(/\.update\(\s*\{\s*payouts_enabled/);
    expect(settingsUi).toMatch(/adminSetDriverPayoutOperationalPause/);
    expect(fwd).toMatch(/deny_direct_driver_payout_pause_write/);
    expect(fwd).toMatch(/direct_payout_pause_write_denied/);
  });

  it('3–5. Resume/pause dual-write + clear operational pause', () => {
    expect(fwd).toMatch(/payout_operational_paused = p_paused/);
    expect(fwd).toMatch(/payouts_enabled = v_after_legacy/);
    expect(fwd).toMatch(/v_after_legacy := NOT p_paused/);
    expect(fwd).toMatch(/FOR UPDATE/);
  });

  it('6–7. Repeated pause/resume is idempotent (unchanged skips audit)', () => {
    expect(fwd).toMatch(/v_unchanged := true/);
    expect(fwd).toMatch(/IF NOT v_unchanged THEN/);
    expect(fwd).toMatch(/INSERT INTO public\.payout_audit_log/);
  });

  it('8–10. Missing / unverified destination and provider UNKNOWN block resume', () => {
    expect(fwd).toMatch(/DESTINATION_NOT_PROVIDER_VERIFIED/);
    expect(fwd).toMatch(/PROVIDER_VERIFIED/);
    expect(fwd).toMatch(/PROVIDER_UNKNOWN/);
    expect(fwd).toMatch(/provider_state.*UNKNOWN|UNKNOWN.*provider_state/s);
  });

  it('11–12. ACTIVE reservation and in-flight payout block resume', () => {
    expect(fwd).toMatch(/ACTIVE_RESERVATION/);
    expect(fwd).toMatch(/PAYOUT_IN_FLIGHT/);
    expect(fwd).toMatch(/execution_status/);
  });

  it('13–14. Credit mismatch and FINANCIAL_READINESS_UNKNOWN fail closed', () => {
    expect(fwd).toMatch(/CREDIT_MISMATCH/);
    expect(fwd).toMatch(/FINANCIAL_READINESS_UNKNOWN/);
    expect(fwd).not.toMatch(/DRIVER_CREDIT_UNKNOWN.*=.*OK|driver_credit_status.*OK/);
  });

  it('15. Pause remains available without financial-health gates', () => {
    const resumeBlock = fwd.indexOf('IF p_paused IS FALSE THEN');
    expect(resumeBlock).toBeGreaterThan(0);
    expect(fwd.slice(0, resumeBlock)).toMatch(/assert_finance_payout_ledger_access/);
    expect(fwd).toMatch(/in_flight_noted_on_pause/);
  });

  it('16–20. Resume creates no payout/reservation/wallet/provider/scheduler side effects', () => {
    expect(fwd).not.toMatch(/INSERT INTO public\.payout_items/);
    expect(fwd).not.toMatch(/INSERT INTO public\.driver_payout_reservations/);
    expect(fwd).not.toMatch(/INSERT INTO public\.driver_wallet_ledger/);
    expect(fwd).not.toMatch(/invoke_weekly_payout_scheduler|admin-execute-weekly|http_post|net\.http/i);
    expect(fwd).toMatch(/scheduler_invoked',\s*false/);
    expect(fwd).toMatch(/wallet_mutated',\s*false/);
    expect(fwd).toMatch(/provider_mutated',\s*false/);
    expect(fwd).toMatch(/pg_advisory_xact_lock\(hashtextextended\(p_driver_id::text, 0\)\)/);
    expect(fwd).toMatch(/driver_payout_payment_intents/);
    expect(client).not.toMatch(/SERVICE_ROLE|service_role/);
  });

  it('21–24. Audit once on change; auth + SA scope; concurrent FOR UPDATE', () => {
    expect(fwd).toMatch(/actor_user_id/);
    expect(fwd).toMatch(/service_area_scope_denied/);
    expect(fwd).toMatch(/staff_service_areas/);
    expect(fwd).toMatch(/REVOKE ALL ON FUNCTION public\.admin_set_driver_payout_operational_pause\(uuid, boolean, text\) FROM service_role/);
    expect(fwd).toMatch(/assert_finance_payout_ledger_access/);
    expect(validateOperationalPauseReason('ab')).toBeTruthy();
    expect(validateOperationalPauseReason('valid reason')).toBeNull();
  });

  it('25. £15.26 Pending/Available locked to operational-pause reclassification', () => {
    expect(stageC).toMatch(
      /IF v_operational_paused IS TRUE THEN[\s\S]*?0::bigint[\s\S]*?GREATEST\(0, v_live\)::bigint/,
    );
    const sum = MK0007.ledger.reduce((s, r) => s + r.amount_pence, 0);
    expect(sum).toBe(1526);
    // Ages ≫ 27h — not clearing delay.
    for (const row of MK0007.ledger) {
      const ageH = (Date.parse('2026-09-23T12:00:00Z') - Date.parse(row.created_at)) / 3_600_000;
      expect(ageH).toBeGreaterThan(27);
    }
  });

  it('MK0007 lifetime credit reconstruct is OK; week-scoped Admin view is UNKNOWN', () => {
    const credits: Record<string, number> = {
      '7851dedd-6d52-457e-9269-44a1ac484b72': 535,
      'd2a5149f-3f00-4c51-9c9b-00d3f809303e': 435,
      '25fbc3f1-7e8c-4686-ab85-e05426175d3a': 556,
    };
    const settled = MK0007.trips.map((t) =>
      buildFrDriverSettlementTripRow({
        trip: t as unknown as Record<string, unknown>,
        session: MK0007.sessions[t.id],
        settlement: null,
        actual_wallet_trip_credit_pence: credits[t.id],
        ledger_created_at: MK0007.ledger.find((l) => l.related_trip_id === t.id)?.created_at ?? null,
      }),
    );
    const lifetime = computeFrDriverReconciliation({
      ledger: MK0007.ledger,
      settledTrips: settled,
      completedPayoutItems: [],
      walletEvidenceAvailable: true,
      settlementEvidenceAvailable: true,
      identityMappingValid: true,
      accountVerified: true,
      payout_provider: 'revolut',
      finance_cleared_pence: 1526,
      in_flight_cashout_pence: 0,
      recovery_debt_pence: 0,
      payout_blocked: true,
      provider_account_balance_pence: null,
      provider_account_balance_status: 'NOT_APPLICABLE',
      pending_balance_pence: 1526,
      query_scope_status: 'LIFETIME',
    });
    expect(lifetime.driver_credit_status).toBe('DRIVER_CREDIT_OK');
    expect(lifetime.expected_payable_pence).toBe(1526);
    expect(lifetime.wallet_variance_pence).toBe(0);

    const scoped = buildPeriodScopedFrDriverInputs({
      periodFrom: '2026-09-21T23:00:00.000Z',
      periodTo: '2026-09-23T22:59:59.999Z',
      ledger: MK0007.ledger,
      settledTrips: settled,
      completedPayoutItems: [],
    });
    expect(scoped.settledTrips).toHaveLength(0);
    const week = computeFrDriverReconciliation({
      ledger: scoped.ledger,
      settledTrips: scoped.settledTrips,
      completedPayoutItems: [],
      walletEvidenceAvailable: true,
      settlementEvidenceAvailable: true,
      identityMappingValid: true,
      accountVerified: false,
      payout_provider: 'revolut',
      finance_cleared_pence: 0,
      in_flight_cashout_pence: 0,
      recovery_debt_pence: 0,
      payout_blocked: true,
      provider_account_balance_pence: null,
      provider_account_balance_status: 'NOT_APPLICABLE',
      pending_balance_pence: 1526,
      query_scope_status: 'PERIOD_SCOPED',
    });
    expect(week.driver_credit_status).toBe('DRIVER_CREDIT_UNKNOWN');
  });
});
