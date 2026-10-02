/**
 * Atomic capture-composition acquire (PR #80 transactional certification).
 *
 * ONE database round trip: Edge → payment_session_acquire_capture_composition RPC.
 * Inside that single PostgreSQL transaction the RPC:
 *   pg_advisory_xact_lock(hashtext('capture_composition:' || session_id))
 *   → SELECT payment_sessions FOR UPDATE
 *   → SELECT RESERVED allocations FOR UPDATE
 *   → resume frozen plan OR create immutable plan + freeze timestamp/key
 *   → CAPTURING state
 *   → return frozen plan
 *
 * The Edge financial metadata lock is optional coordination only; plan
 * identity is owned by the RPC transaction. Never reload/plan/persist via
 * separate Edge queries after a lock RPC returns — advisory_xact_lock ends
 * when that statement's transaction commits.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  claimPaymentSessionFinancialLock,
  releasePaymentSessionFinancialLock,
  type FinancialLockClaim,
} from "./paymentSessionFinancialLockSSOT.ts";
import {
  CAPTURE_COMPOSITION_VERSION,
  type CaptureCompositionPlan,
} from "./captureCompositionSSOT.ts";
import {
  CAPTURE_COMPOSITION_ERROR,
  detectReceivableCaptureEvidence,
  type CaptureCompositionErrorCode,
} from "./captureCompositionFreezeSSOT.ts";

export const ACQUIRE_CAPTURE_COMPOSITION_RPC =
  "payment_session_acquire_capture_composition" as const;

export type AcquireCaptureCompositionResult =
  | {
    ok: true;
    kind: "resumed" | "created" | "legacy_fare_tip";
    plan: CaptureCompositionPlan | null;
    provider_capture_target_pence: number;
    capture_idempotency_key: string | null;
    lock_owner: string;
    lock_claimed_here: boolean;
  }
  | {
    ok: false;
    code:
      | CaptureCompositionErrorCode
      | "CAPTURE_BUSY"
      | "PAYMENT_SESSION_MISSING"
      | "CAPTURE_COMPOSITION_MIGRATION_REQUIRED";
    error: string;
    lock_claimed_here: boolean;
    lock_owner?: string;
  };

type RpcAcquireRow = {
  ok?: boolean;
  kind?: string;
  code?: string;
  error?: string;
  provider_capture_target_pence?: number | null;
  capture_idempotency_key?: string | null;
  trip_fare_component_pence?: number | null;
  tip_component_pence?: number | null;
  receivable_component_pence?: number | null;
  preauth_buffer_component_pence?: number | null;
  capture_composition_frozen_at?: string | null;
  lock_owner?: string | null;
  payment_session_id?: string | null;
  provider_order_id?: string | null;
  authorised_total_pence?: number | null;
};

function isMissingRpcError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("could not find the function")
    || m.includes("pgrst202")
    || m.includes("42883")
    || m.includes("does not exist")
    || m.includes(ACQUIRE_CAPTURE_COMPOSITION_RPC.toLowerCase())
      && (m.includes("schema cache") || m.includes("not found"))
  );
}

function planFromRpc(
  row: RpcAcquireRow,
  authorised: number,
): CaptureCompositionPlan | null {
  const key = row.capture_idempotency_key != null
    ? String(row.capture_idempotency_key)
    : "";
  const target = Math.round(Number(row.provider_capture_target_pence) || 0);
  const fare = Math.round(Number(row.trip_fare_component_pence) || 0);
  const tip = Math.round(Number(row.tip_component_pence) || 0);
  const recv = Math.round(Number(row.receivable_component_pence) || 0);
  const buffer = Math.round(Number(row.preauth_buffer_component_pence) || 0);
  const sessionId = String(row.payment_session_id ?? "").trim();
  const orderId = String(row.provider_order_id ?? "").trim();
  if (!key || !sessionId || !orderId || target <= 0) return null;
  if (target !== fare + tip + recv) return null;
  const authTarget = fare + recv + buffer;
  return {
    ok: true,
    trip_fare_component_pence: fare,
    tip_component_pence: tip,
    receivable_component_pence: recv,
    preauth_buffer_component_pence: buffer,
    provider_capture_target_pence: target,
    provider_authorisation_target_pence: authTarget,
    provider_release_amount_pence: Math.max(0, authTarget - target),
    displayed_customer_total_pence: fare + recv,
    authorised_total_pence: authorised,
    payment_session_id: sessionId,
    provider_order_id: orderId,
    capture_idempotency_key: key,
    composition_version: CAPTURE_COMPOSITION_VERSION,
    reserved_allocation_ids: [],
  };
}

/**
 * Canonical acquire: single atomic RPC. No Edge multi-round-trip plan path.
 */
export async function acquireLockAndResolveCaptureComposition(
  supabase: SupabaseClient,
  args: {
    payment_session_id: string;
    provider_order_id: string;
    trip_fare_component_pence: number;
    tip_component_pence?: number;
    tip_authorisation_declined?: boolean;
    authorised_total_pence: number;
    preauth_buffer_component_pence?: number | null;
    customer_payable_pence?: number | null;
    lock_owner: string;
    operation_key?: string | null;
    /** When caller already holds CAPTURING lock (e.g. admin capture). */
    lock_already_held?: boolean;
  },
): Promise<AcquireCaptureCompositionResult> {
  const sessionId = String(args.payment_session_id ?? "").trim();
  const orderId = String(args.provider_order_id ?? "").trim();
  const owner = String(args.lock_owner ?? "").trim() || `capture:${sessionId}`;
  let lockClaimedHere = false;

  if (!sessionId || !orderId) {
    return {
      ok: false,
      code: "PAYMENT_SESSION_MISSING",
      error: "payment_session_id and provider_order_id required",
      lock_claimed_here: false,
    };
  }

  // Best-effort metadata CAS coordination (separate from xact advisory lock).
  // Plan identity is decided only inside the atomic RPC below.
  if (!args.lock_already_held) {
    const lock: FinancialLockClaim = await claimPaymentSessionFinancialLock(supabase, {
      paymentSessionId: sessionId,
      owner,
      state: "CAPTURING",
      operationKey: args.operation_key ?? `capture-composition:${orderId}`,
    });
    if (!lock.ok) {
      return {
        ok: false,
        code: "CAPTURE_BUSY",
        error: `Financial operation busy (${lock.currentState ?? "unknown"})`,
        lock_claimed_here: false,
      };
    }
    lockClaimedHere = true;
  }

  const releaseIfNeeded = async () => {
    if (lockClaimedHere) {
      await releasePaymentSessionFinancialLock(supabase, {
        paymentSessionId: sessionId,
        owner,
        nextState: "IDLE",
      });
    }
  };

  const tip = args.tip_authorisation_declined === true
    ? 0
    : Math.max(0, Math.round(Number(args.tip_component_pence ?? 0) || 0));
  const fare = Math.max(0, Math.round(Number(args.trip_fare_component_pence) || 0));
  const buffer = args.preauth_buffer_component_pence != null
    ? Math.max(0, Math.round(Number(args.preauth_buffer_component_pence) || 0))
    : 0;
  const authorised = Math.max(0, Math.round(Number(args.authorised_total_pence) || 0));

  try {
    const { data, error } = await supabase.rpc(ACQUIRE_CAPTURE_COMPOSITION_RPC, {
      p_payment_session_id: sessionId,
      p_provider_order_id: orderId,
      p_trip_fare_component_pence: fare,
      p_tip_component_pence: tip,
      p_preauth_buffer_component_pence: buffer,
      p_authorised_total_pence: authorised,
      p_lock_owner: owner,
      p_operation_key: args.operation_key ?? null,
    });

    if (error) {
      await releaseIfNeeded();
      const msg = error.message ?? String(error);
      if (isMissingRpcError(msg)) {
        return {
          ok: false,
          code: "CAPTURE_COMPOSITION_MIGRATION_REQUIRED",
          error:
            "payment_session_acquire_capture_composition RPC missing — apply migration before capture",
          lock_claimed_here: lockClaimedHere,
          lock_owner: owner,
        };
      }
      return {
        ok: false,
        code: CAPTURE_COMPOSITION_ERROR.CAPTURE_COMPOSITION_REQUIRED,
        error: msg,
        lock_claimed_here: lockClaimedHere,
        lock_owner: owner,
      };
    }

    const row = (data && typeof data === "object" ? data : {}) as RpcAcquireRow;
    if (row.ok !== true) {
      await releaseIfNeeded();
      const code = String(row.code ?? CAPTURE_COMPOSITION_ERROR.CAPTURE_COMPOSITION_REQUIRED);
      return {
        ok: false,
        code: code as CaptureCompositionErrorCode | "PAYMENT_SESSION_MISSING",
        error: String(row.error ?? code),
        lock_claimed_here: lockClaimedHere,
        lock_owner: owner,
      };
    }

    const kindRaw = String(row.kind ?? "");
    const kind: "resumed" | "created" | "legacy_fare_tip" =
      kindRaw === "resumed" || kindRaw === "created" || kindRaw === "legacy_fare_tip"
        ? kindRaw
        : "created";

    if (kind === "legacy_fare_tip") {
      return {
        ok: true,
        kind: "legacy_fare_tip",
        plan: null,
        provider_capture_target_pence: Math.max(
          0,
          Math.round(Number(row.provider_capture_target_pence) || fare + tip),
        ),
        capture_idempotency_key: null,
        lock_owner: owner,
        lock_claimed_here: lockClaimedHere,
      };
    }

    const plan = planFromRpc(row, authorised);
    if (!plan) {
      await releaseIfNeeded();
      return {
        ok: false,
        code: CAPTURE_COMPOSITION_ERROR.CAPTURE_COMPOSITION_REQUIRED,
        error: "atomic_rpc_returned_invalid_plan",
        lock_claimed_here: lockClaimedHere,
        lock_owner: owner,
      };
    }

    return {
      ok: true,
      kind,
      plan,
      provider_capture_target_pence: plan.provider_capture_target_pence,
      capture_idempotency_key: plan.capture_idempotency_key,
      lock_owner: owner,
      lock_claimed_here: lockClaimedHere,
    };
  } catch (err) {
    await releaseIfNeeded();
    const msg = err instanceof Error ? err.message : String(err);
    if (isMissingRpcError(msg)) {
      return {
        ok: false,
        code: "CAPTURE_COMPOSITION_MIGRATION_REQUIRED",
        error:
          "payment_session_acquire_capture_composition RPC missing — apply migration before capture",
        lock_claimed_here: lockClaimedHere,
        lock_owner: owner,
      };
    }
    return {
      ok: false,
      code: CAPTURE_COMPOSITION_ERROR.CAPTURE_COMPOSITION_REQUIRED,
      error: msg,
      lock_claimed_here: lockClaimedHere,
      lock_owner: owner,
    };
  }
}

/** Fail closed when receivable evidence exists but no payment session. */
export function failClosedWithoutSessionWhenReceivableEvidence(args: {
  metadata?: Record<string, unknown> | null;
  customer_receivables_pence?: number | null;
}): AcquireCaptureCompositionResult | null {
  const evidence = detectReceivableCaptureEvidence({
    metadata: args.metadata ?? {},
    customer_receivables_pence: args.customer_receivables_pence,
    reserved_allocations: [],
  });
  if (!evidence.has_evidence) return null;
  return {
    ok: false,
    code: CAPTURE_COMPOSITION_ERROR.CAPTURE_COMPOSITION_REQUIRED,
    error: "receivable_evidence_without_payment_session",
    lock_claimed_here: false,
  };
}
