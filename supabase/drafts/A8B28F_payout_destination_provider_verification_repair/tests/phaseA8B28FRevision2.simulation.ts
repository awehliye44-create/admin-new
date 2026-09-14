/**
 * A8B28F revised simulation — pure + matrix. No provider/DB mutation.
 */
import {
  PAYOUT_DESTINATION_OUTCOME,
  PROVIDER_LINK_FAILURE_CLASS,
  balancePresentation,
  classifyCounterpartyCreateFailure,
  effectivePayoutAllowed,
  httpStatusForOutcome,
  interpretCompat,
  isClientSuccessOutcome,
  resolveSyncUkRevolutOutcome,
} from "./compatHarness.ts";

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}
function assertEq<T>(a: T, e: T, msg: string): void {
  if (a !== e) throw new Error(`${msg}: expected ${String(e)} got ${String(a)}`);
}

// --- failure / response contract ---
{
  const o = resolveSyncUkRevolutOutcome({
    saveOk: true,
    linkStatus: "FAILED",
    verificationStatus: "PENDING_VERIFICATION",
    hasCounterpartyRef: false,
    hasRecipientRef: false,
  });
  assertEq(o, PAYOUT_DESTINATION_OUTCOME.DESTINATION_SAVED_VERIFICATION_FAILED, "failed");
  assert(!isClientSuccessOutcome(o), "no false success");
  assertEq(httpStatusForOutcome(o), 422, "422");
}

{
  const c = classifyCounterpartyCreateFailure({
    provider_error_code: "COUNTERPARTY_CREATE_FAILED",
    http_status: null,
  });
  assertEq(c, PROVIDER_LINK_FAILURE_CLASS.UNRESOLVED_PROVIDER_CALL_REQUIRED, "mk class");
}

// Mixed client/edge
{
  const legacyFalseSuccess = interpretCompat({
    httpOk: true,
    httpStatus: 200,
    payload: { success: true, provider_auto_linked: false, provider_link_status: "FAILED" },
  });
  assert(!legacyFalseSuccess.ok, "old edge + new client fail closed");

  const newEdgeOldClient = interpretCompat({
    httpOk: false,
    httpStatus: 422,
    payload: { success: false, outcome: "DESTINATION_SAVED_VERIFICATION_FAILED" },
  });
  assert(!newEdgeOldClient.ok, "new edge old client sees failure");
}

// Option B pause preserved
{
  const paused = effectivePayoutAllowed({
    global_payouts_enabled: true,
    provider_verified_active_destination: true,
    payout_operational_paused: true,
    driver_approved: true,
    driver_suspended: false,
  });
  assert(!paused.effective_payout_allowed, "pause wins");
  assertEq(paused.block_reason, "ADMIN_HOLD", "admin hold");
}

// MK0006-like non-withdrawable even if cleared available after Stage C
{
  const mk = effectivePayoutAllowed({
    global_payouts_enabled: true,
    provider_verified_active_destination: false,
    payout_operational_paused: false,
    driver_approved: true,
    driver_suspended: false,
  });
  assert(!mk.effective_payout_allowed, "mk blocked");
  const bal = balancePresentation({
    cleared_pence: 425,
    uncleared_pending_pence: 0,
    payout_operational_paused: false,
    effective_payout_allowed: false,
    minimum_pence: 0,
    block_reason: mk.block_reason,
  });
  assertEq(bal.available_pence, 425, "stage C available shows cleared");
  assertEq(bal.withdrawable_pence, 0, "not withdrawable");
  assert(bal.ui_reason.includes("verification"), "ui reason");
}

// Full matrix (cleared? verified? pause? global?) — minimum=0
type Row = {
  cleared: boolean;
  verified: boolean;
  pause: boolean;
  global: boolean;
  available: number;
  withdrawable: number;
  pending: number;
  reasonIncludes: string;
};
const CLEARED = 425;
const PENDING = 100;
const rows: Row[] = [];
for (const cleared of [true, false]) {
  for (const verified of [true, false]) {
    for (const pause of [true, false]) {
      for (const global of [true, false]) {
        const eff = effectivePayoutAllowed({
          global_payouts_enabled: global,
          provider_verified_active_destination: verified,
          payout_operational_paused: pause,
          driver_approved: true,
          driver_suspended: false,
        });
        const bal = balancePresentation({
          cleared_pence: cleared ? CLEARED : 0,
          uncleared_pending_pence: cleared ? 0 : PENDING,
          payout_operational_paused: pause,
          effective_payout_allowed: eff.effective_payout_allowed,
          minimum_pence: 0,
          block_reason: eff.block_reason,
        });
        rows.push({
          cleared,
          verified,
          pause,
          global,
          available: bal.available_pence,
          withdrawable: bal.withdrawable_pence,
          pending: bal.pending_pence,
          reasonIncludes: bal.ui_reason,
        });
      }
    }
  }
}
assertEq(rows.length, 16, "matrix size");
// Unverified + cleared + not paused + global on → available>0 withdrawable=0
{
  const r = rows.find((x) => x.cleared && !x.verified && !x.pause && x.global)!;
  assertEq(r.available, 425, "unverified available");
  assertEq(r.withdrawable, 0, "unverified not withdrawable");
}
// Paused always available=0
for (const r of rows.filter((x) => x.pause)) {
  assertEq(r.available, 0, "paused available 0");
  assertEq(r.withdrawable, 0, "paused withdrawable 0");
}
// Verified + not paused + global + cleared → withdrawable
{
  const r = rows.find((x) => x.cleared && x.verified && !x.pause && x.global)!;
  assertEq(r.withdrawable, 425, "ready withdrawable");
}

console.log("A8B28F_REVISION2_SIMULATION_OK rows=" + rows.length);
