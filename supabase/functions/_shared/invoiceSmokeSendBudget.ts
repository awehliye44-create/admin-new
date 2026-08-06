/**
 * Atomic smoke-run provider send budget helpers + pure counter tests.
 *
 * Model mirrors DB RPCs:
 * - acquire: reserve a slot (does not increment successful)
 * - confirm: provider accepted → successful++
 * - release: provider failed → free reservation
 */

export type SmokeBudgetState = {
  smoke_run_id: string;
  status: "open" | "closed" | "failed" | "passed";
  max_successful_sends: number;
  successful_send_count: number;
  attempted_send_count: number;
  reserved_send_count: number;
};

export type SmokeSlotResult =
  | { ok: true; code: "SLOT_ACQUIRED"; state: SmokeBudgetState }
  | { ok: false; code: string; state?: SmokeBudgetState };

export function acquireSmokeSendSlotPure(state: SmokeBudgetState): SmokeSlotResult {
  if (state.status !== "open") {
    return { ok: false, code: "SMOKE_RUN_CLOSED", state };
  }
  const attempted = {
    ...state,
    attempted_send_count: state.attempted_send_count + 1,
  };
  if (attempted.successful_send_count + attempted.reserved_send_count >= attempted.max_successful_sends) {
    return { ok: false, code: "SMOKE_SEND_LIMIT_REACHED", state: attempted };
  }
  const next = {
    ...attempted,
    reserved_send_count: attempted.reserved_send_count + 1,
  };
  return { ok: true, code: "SLOT_ACQUIRED", state: next };
}

export function confirmSmokeSendSlotPure(state: SmokeBudgetState): SmokeBudgetState {
  return {
    ...state,
    reserved_send_count: Math.max(0, state.reserved_send_count - 1),
    successful_send_count: state.successful_send_count + 1,
  };
}

export function releaseSmokeSendSlotPure(state: SmokeBudgetState): SmokeBudgetState {
  return {
    ...state,
    reserved_send_count: Math.max(0, state.reserved_send_count - 1),
  };
}

/** Simulate N concurrent acquires against one shared counter (serialized lock). */
export function simulateConcurrentSmokeAcquires(
  initial: SmokeBudgetState,
  claimants: number,
): { winners: number; results: SmokeSlotResult[]; final: SmokeBudgetState } {
  let state = { ...initial };
  const results: SmokeSlotResult[] = [];
  let winners = 0;
  for (let i = 0; i < claimants; i++) {
    const r = acquireSmokeSendSlotPure(state);
    results.push(r);
    if (r.ok) {
      winners += 1;
      state = r.state;
    } else if (r.state) {
      state = r.state;
    }
  }
  return { winners, results, final: state };
}

/**
 * Prove requests 1–max can acquire; request max+1 is SMOKE_SEND_LIMIT_REACHED
 * with zero provider calls when gated before the API.
 */
export function runSmokeBudgetSendSequence(
  max: number,
  requests: number,
): {
  providerCalls: number;
  successes: number;
  fifthRejected: boolean;
  final: SmokeBudgetState;
} {
  let state: SmokeBudgetState = {
    smoke_run_id: "SMOKE-TEST",
    status: "open",
    max_successful_sends: max,
    successful_send_count: 0,
    attempted_send_count: 0,
    reserved_send_count: 0,
  };
  let providerCalls = 0;
  let successes = 0;
  let fifthRejected = false;

  for (let i = 1; i <= requests; i++) {
    const slot = acquireSmokeSendSlotPure(state);
    if (!slot.ok) {
      if (i === max + 1 && slot.code === "SMOKE_SEND_LIMIT_REACHED") fifthRejected = true;
      if (slot.state) state = slot.state;
      continue;
    }
    state = slot.state;
    // Provider call only after slot acquired
    providerCalls += 1;
    state = confirmSmokeSendSlotPure(state);
    successes += 1;
  }

  return { providerCalls, successes, fifthRejected, final: state };
}
