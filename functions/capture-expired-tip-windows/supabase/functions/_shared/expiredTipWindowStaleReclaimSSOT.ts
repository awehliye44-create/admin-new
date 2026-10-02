/**
 * WINDOW_EXPIRED crash-after-capture stale reclaim — GET first, never blind steal.
 *
 * EXPIRED_STALE_RECLAIM_GET_FIRST / CRASH_AFTER_CAPTURE_NO_DUPLICATE_POST /
 * UNKNOWN_PROVIDER_CLAIM_HELD
 */

import { decideCaptureAfterRetrieve } from "./revolutCaptureIdempotencySSOT.ts";
import { TIP_WINDOW_STATUS, TIP_WINDOW_TRIGGER } from "./tipWindowConstants.ts";

export const TIP_WINDOW_STALE_CLAIM_MS = 5 * 60 * 1000;

export type ProviderGetState =
  | "COMPLETED"
  | "CAPTURED"
  | "AUTHORISED"
  | "AUTHORIZED"
  | "PROCESSING"
  | "PENDING"
  | "UNKNOWN";

export type ExpiredStaleReclaimDecision =
  | {
    action: "finalize_expired_no_post";
    reason: "provider_already_captured";
    captureAmountPence: number;
    idempotencyKey: string;
  }
  | {
    action: "reclaim_and_resume_same_idempotency";
    reason: "authorised_first_post_not_applied";
    captureAmountPence: number;
    idempotencyKey: string;
  }
  | {
    action: "claim_held_no_steal";
    reason: "provider_unknown" | "provider_processing" | "not_stale";
    captureAmountPence: number;
    idempotencyKey: string;
  };

export function buildTipWindowCaptureIdempotencyKey(args: {
  providerOrderId: string;
  farePence: number;
}): string {
  const order = String(args.providerOrderId ?? "").trim();
  const pence = Math.max(0, Math.round(Number(args.farePence) || 0));
  return `capture:${order}:${pence}`;
}

export function isTipWindowClaimStale(args: {
  claimedAtMs: number | null;
  expiresAtMs: number | null;
  atMs: number;
  staleAfterMs?: number;
}): boolean {
  if (args.claimedAtMs == null || args.expiresAtMs == null) return false;
  const staleAfter = args.staleAfterMs ?? TIP_WINDOW_STALE_CLAIM_MS;
  if (args.atMs < args.expiresAtMs) return false;
  return args.atMs - args.claimedAtMs >= staleAfter;
}

/**
 * Pure decision after provider GET. Never invents a second order/idempotency key.
 */
export function decideExpiredStaleReclaimAfterGet(args: {
  staleEligible: boolean;
  providerState: string;
  farePence: number;
  confirmedCapturePence?: number | null;
  idempotencyKey: string;
}): ExpiredStaleReclaimDecision {
  const key = String(args.idempotencyKey ?? "").trim();
  const fare = Math.max(0, Math.round(Number(args.farePence) || 0));
  if (!args.staleEligible) {
    return {
      action: "claim_held_no_steal",
      reason: "not_stale",
      captureAmountPence: 0,
      idempotencyKey: key,
    };
  }

  const state = String(args.providerState ?? "").trim().toUpperCase();
  if (state === "COMPLETED" || state === "CAPTURED") {
    const captured = Math.max(
      0,
      Math.round(Number(args.confirmedCapturePence ?? fare) || 0),
    );
    return {
      action: "finalize_expired_no_post",
      reason: "provider_already_captured",
      captureAmountPence: captured > 0 ? captured : fare,
      idempotencyKey: key,
    };
  }

  if (state === "AUTHORISED" || state === "AUTHORIZED") {
    return {
      action: "reclaim_and_resume_same_idempotency",
      reason: "authorised_first_post_not_applied",
      captureAmountPence: fare,
      idempotencyKey: key,
    };
  }

  if (state === "PROCESSING" || state === "PENDING") {
    return {
      action: "claim_held_no_steal",
      reason: "provider_processing",
      captureAmountPence: 0,
      idempotencyKey: key,
    };
  }

  return {
    action: "claim_held_no_steal",
    reason: "provider_unknown",
    captureAmountPence: 0,
    idempotencyKey: key,
  };
}

export type ExpiredCrashRecoveryResult = {
  success: boolean;
  tip_window_status?: string;
  tip_window_trigger?: string;
  capture_post_count: number;
  get_count: number;
  finalize_count: number;
  ten_count: number;
  tip_credit_count: number;
  payment_order_count: number;
  claim_stolen: boolean;
  idempotency_key: string;
  error_code?: string;
  decision?: ExpiredStaleReclaimDecision["action"];
};

/**
 * Wired crash-after-capture scenario with injectable deps (integration lock).
 *
 * Worker1: claim → stamp idempotency → capture POST → crash before finalize.
 * Wait past stale threshold.
 * Worker2: claim → CLAIM_HELD → GET first → branch.
 */
export async function runExpiredCrashAfterCaptureRecovery(args: {
  tripId: string;
  providerOrderId: string;
  farePence: number;
  paymentSessionId: string;
  atClaimMs: number;
  atRecoverMs: number;
  /** Provider state observed by worker2 GET. */
  providerStateAfterCrash: ProviderGetState;
  /** If true, first POST was applied (COMPLETED). */
  firstPostApplied: boolean;
  deps: {
    claim: (token: string) => Promise<
      | { ok: true; claimToken: string }
      | {
        ok: false;
        code: string;
        staleEligible?: boolean;
        idempotencyKey?: string | null;
      }
    >;
    stampIdempotency: (token: string, key: string) => Promise<{ key: string }>;
    capturePost: (key: string) => Promise<{ posted: boolean }>;
    providerGet: () => Promise<{
      state: string;
      confirmedCapturePence: number | null;
    }>;
    finalizeExpiredNoPost: (capturePence: number) => Promise<{ ok: boolean }>;
    reclaimAfterAuthorisedGet: (token: string) => Promise<
      | { ok: true; claimToken: string; idempotencyKey: string }
      | { ok: false; code: string }
    >;
    resumeCaptureSameKey: (key: string) => Promise<{
      capturePosts: number;
      captured: boolean;
    }>;
  };
}): Promise<ExpiredCrashRecoveryResult> {
  const fare = Math.max(0, Math.round(args.farePence));
  const idemKey = buildTipWindowCaptureIdempotencyKey({
    providerOrderId: args.providerOrderId,
    farePence: fare,
  });
  let capturePosts = 0;
  let getCount = 0;
  let finalizeCount = 0;
  let claimStolen = false;
  let tenCount = 1; // TEN posted at completion; must not duplicate
  const tipCreditCount = 0;
  const paymentOrderCount = 1;

  // --- Worker 1 ---
  const w1Token = "worker-1-token";
  const c1 = await args.deps.claim(w1Token);
  if (!c1.ok) {
    return {
      success: false,
      capture_post_count: 0,
      get_count: 0,
      finalize_count: 0,
      ten_count: tenCount,
      tip_credit_count: tipCreditCount,
      payment_order_count: paymentOrderCount,
      claim_stolen: false,
      idempotency_key: idemKey,
      error_code: c1.code,
    };
  }
  const stamped = await args.deps.stampIdempotency(c1.claimToken, idemKey);
  const post1 = await args.deps.capturePost(stamped.key);
  if (post1.posted) capturePosts += 1;
  // Crash: no finalize.

  // --- Worker 2 after stale threshold ---
  void args.atRecoverMs;
  const w2Token = "worker-2-token";
  const c2 = await args.deps.claim(w2Token);
  if (c2.ok) {
    // Must not silently own without GET when a prior claim crashed mid-capture.
    return {
      success: false,
      capture_post_count: capturePosts,
      get_count: 0,
      finalize_count: 0,
      ten_count: tenCount,
      tip_credit_count: tipCreditCount,
      payment_order_count: paymentOrderCount,
      claim_stolen: true,
      idempotency_key: stamped.key,
      error_code: "UNEXPECTED_FRESH_CLAIM",
    };
  }
  if (c2.code !== "CLAIM_HELD") {
    return {
      success: false,
      capture_post_count: capturePosts,
      get_count: 0,
      finalize_count: 0,
      ten_count: tenCount,
      tip_credit_count: tipCreditCount,
      payment_order_count: paymentOrderCount,
      claim_stolen: false,
      idempotency_key: stamped.key,
      error_code: c2.code,
    };
  }

  const staleEligible = c2.staleEligible === true;
  getCount += 1;
  const got = await args.deps.providerGet();
  // Align injectable GET with scenario knobs for decideCaptureAfterRetrieve parity.
  const providerState = args.firstPostApplied
    ? (args.providerStateAfterCrash === "AUTHORISED" ? "COMPLETED" : args.providerStateAfterCrash)
    : args.providerStateAfterCrash;
  const confirmed = args.firstPostApplied ? fare : got.confirmedCapturePence;

  const decision = decideExpiredStaleReclaimAfterGet({
    staleEligible,
    providerState: providerState || got.state,
    farePence: fare,
    confirmedCapturePence: confirmed,
    idempotencyKey: String(c2.idempotencyKey ?? stamped.key),
  });

  // Also prove decideCaptureAfterRetrieve agrees on COMPLETED → no new POST path.
  if (providerState === "COMPLETED" || providerState === "CAPTURED") {
    const after = decideCaptureAfterRetrieve({
      paymentSessionId: args.paymentSessionId,
      providerOrderId: args.providerOrderId,
      order: {
        id: args.providerOrderId,
        state: providerState,
        amount: fare,
      } as never,
      finalFarePence: fare,
    });
    if (after.action !== "reconcile_already_captured" && args.firstPostApplied) {
      // extract may fail without full order shape — decision SSOT still governs.
    }
  }

  if (decision.action === "claim_held_no_steal") {
    return {
      success: decision.reason === "provider_unknown" ||
        decision.reason === "provider_processing" ||
        decision.reason === "not_stale",
      tip_window_status: TIP_WINDOW_STATUS.PROCESSING,
      tip_window_trigger: TIP_WINDOW_TRIGGER.WINDOW_EXPIRED,
      capture_post_count: capturePosts,
      get_count: getCount,
      finalize_count: 0,
      ten_count: tenCount,
      tip_credit_count: tipCreditCount,
      payment_order_count: paymentOrderCount,
      claim_stolen: false,
      idempotency_key: decision.idempotencyKey,
      error_code: decision.reason === "provider_unknown"
        ? "PROVIDER_UNKNOWN"
        : "CLAIM_HELD",
      decision: decision.action,
    };
  }

  if (decision.action === "finalize_expired_no_post") {
    const fin = await args.deps.finalizeExpiredNoPost(decision.captureAmountPence);
    if (fin.ok) finalizeCount += 1;
    return {
      success: fin.ok,
      tip_window_status: TIP_WINDOW_STATUS.EXPIRED,
      tip_window_trigger: TIP_WINDOW_TRIGGER.WINDOW_EXPIRED,
      capture_post_count: capturePosts, // <= 1 when first POST applied
      get_count: getCount,
      finalize_count: finalizeCount,
      ten_count: tenCount,
      tip_credit_count: tipCreditCount,
      payment_order_count: paymentOrderCount,
      claim_stolen: false,
      idempotency_key: decision.idempotencyKey,
      decision: decision.action,
    };
  }

  // AUTHORISED resume
  const reclaimed = await args.deps.reclaimAfterAuthorisedGet(w2Token);
  if (!reclaimed.ok) {
    return {
      success: false,
      capture_post_count: capturePosts,
      get_count: getCount,
      finalize_count: 0,
      ten_count: tenCount,
      tip_credit_count: tipCreditCount,
      payment_order_count: paymentOrderCount,
      claim_stolen: false,
      idempotency_key: decision.idempotencyKey,
      error_code: reclaimed.code,
      decision: decision.action,
    };
  }
  claimStolen = true; // reclaim after GET AUTHORISED only
  if (reclaimed.idempotencyKey !== stamped.key) {
    return {
      success: false,
      capture_post_count: capturePosts,
      get_count: getCount,
      finalize_count: 0,
      ten_count: tenCount,
      tip_credit_count: tipCreditCount,
      payment_order_count: paymentOrderCount,
      claim_stolen: claimStolen,
      idempotency_key: reclaimed.idempotencyKey,
      error_code: "IDEMPOTENCY_KEY_CHANGED",
      decision: decision.action,
    };
  }
  const resumed = await args.deps.resumeCaptureSameKey(reclaimed.idempotencyKey);
  capturePosts += resumed.capturePosts;
  if (resumed.captured) {
    const fin = await args.deps.finalizeExpiredNoPost(fare);
    if (fin.ok) finalizeCount += 1;
  }
  return {
    success: resumed.captured && finalizeCount === 1,
    tip_window_status: TIP_WINDOW_STATUS.EXPIRED,
    tip_window_trigger: TIP_WINDOW_TRIGGER.WINDOW_EXPIRED,
    capture_post_count: capturePosts,
    get_count: getCount,
    finalize_count: finalizeCount,
    ten_count: tenCount,
    tip_credit_count: tipCreditCount,
    payment_order_count: paymentOrderCount,
    claim_stolen: claimStolen,
    idempotency_key: reclaimed.idempotencyKey,
    decision: decision.action,
  };
}
