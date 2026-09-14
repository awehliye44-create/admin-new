/**
 * A8B28F Stage C companion source-lock (draft artifacts only — not deployed).
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../..');
const BRIEF = resolve(ROOT, 'supabase/drafts/A8B28F_stage_c_companion/notes/PHASE_BRIEF.txt');
const INV = resolve(ROOT, 'supabase/drafts/A8B28F_stage_c_companion/notes/INVENTORY.txt');
const BANNER = resolve(
  ROOT,
  '..', 'ONECAB', 'onecab-driver-native', 'src/features/wallet/drafts/A8B28F_stage_c_companion/resolvePayoutAccountBanner.draft.ts',
);
const ELIG = resolve(ROOT, 'supabase/drafts/A8B28F_stage_c_companion/edge/driverPayoutEligibilitySSOT.draft.ts');
const BATCH = resolve(ROOT, 'supabase/drafts/A8B28F_stage_c_companion/edge/weeklyDriverPayoutBatchWorkflowSSOT.draft.ts');
const PAUSE = resolve(ROOT, 'supabase/drafts/A8B28F_stage_c_companion/admin/PayoutLedger.pause.draft.ts');
const LIVE_BANNER = resolve(
  ROOT,
  '..', 'ONECAB', 'onecab-driver-native', 'src/features/wallet/lib/resolvePayoutAccountBanner.ts',
);
const LIVE_LEDGER = resolve(ROOT, 'src/pages/PayoutLedger.tsx');

describe('phase A8B28F Stage C companion drafts (not deployed)', () => {
  it('ships brief + inventory + key drafts', () => {
    expect(existsSync(BRIEF)).toBe(true);
    expect(existsSync(INV)).toBe(true);
    expect(existsSync(BANNER)).toBe(true);
    expect(existsSync(ELIG)).toBe(true);
    expect(existsSync(BATCH)).toBe(true);
    expect(existsSync(PAUSE)).toBe(true);
    const brief = readFileSync(BRIEF, 'utf8');
    expect(brief).toMatch(/DRAFT ONLY/);
    expect(brief).toMatch(/No app\/Edge\/Admin deploy/);
  });

  it('Driver banner draft drops legacy OR into pause', () => {
    const draft = readFileSync(BANNER, 'utf8');
    expect(draft).toMatch(/payoutOperationalPaused === true/);
    expect(draft).toMatch(/do NOT OR legacyPayoutsDisabled/);
    expect(draft).not.toMatch(/legacyPayoutsDisabled === true/);
  });

  it('live Driver banner no longer ORs legacy into pause (Phase 1 companion shipped)', () => {
    const live = readFileSync(LIVE_BANNER, 'utf8');
    expect(live).toMatch(/payoutOperationalPaused === true/);
    expect(live).not.toMatch(/legacyPayoutsDisabled === true/);
  });

  it('eligibility draft switches short-circuit to OP and forbids unverified zeroing Available', () => {
    const draft = readFileSync(ELIG, 'utf8');
    expect(draft).toMatch(/payout_operational_paused === true/);
    expect(draft).toMatch(/accountUnverifiedMustNotZeroAvailable: true/);
    expect(draft).toMatch(/ignoreLegacyPayoutsEnabled: true/);
    expect(draft).toMatch(/clearingMathUnchanged: true/);
  });

  it('batch draft gates on OP not legacy payouts_enabled', () => {
    const draft = readFileSync(BATCH, 'utf8');
    expect(draft).toMatch(/payout_operational_paused: boolean/);
    expect(draft).toMatch(/OPERATIONAL_PAUSE/);
    expect(draft).not.toMatch(/input\.payouts_enabled/);
  });

  it('Admin pause draft uses RPC; live PayoutLedger still direct-writes legacy', () => {
    const draft = readFileSync(PAUSE, 'utf8');
    expect(draft).toMatch(/admin_set_driver_payout_operational_pause|adminSetDriverPayoutOperationalPause/);
    const live = readFileSync(LIVE_LEDGER, 'utf8');
    expect(live).toMatch(/update\(\{\s*payouts_enabled:\s*row\.paused\s*\}\)/);
  });
});
