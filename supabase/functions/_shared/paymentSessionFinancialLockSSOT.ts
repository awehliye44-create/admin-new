/**
 * Payment Session financial operation lock (DB compare-and-set via metadata + column).
 * Prevents concurrent increment / capture / recovery on the same session.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { mutatePaymentSession, mutatePaymentSessionReturningId } from "./paymentSessionMutationCore.ts";

export type FinancialOperationState =
  | "IDLE"
  | "INCREMENTING"
  | "CAPTURING"
  | "RECONCILING"
  | "RECOVERY_PENDING"
  | "CAPTURED";

const LOCK_TTL_MS = 90_000;

export type FinancialLockClaim =
  | { ok: true; owner: string; state: FinancialOperationState }
  | {
    ok: false;
    reason: "busy" | "missing_session" | "claim_failed";
    currentState: FinancialOperationState | null;
    currentOwner: string | null;
  };

function readLock(session: Record<string, unknown> | null): {
  state: FinancialOperationState;
  owner: string | null;
  startedAtMs: number | null;
} {
  const col = String(session?.financial_operation_state ?? "").toUpperCase();
  const meta = session?.metadata && typeof session.metadata === "object"
    ? session.metadata as Record<string, unknown>
    : {};
  const metaState = String(meta.financial_operation_state ?? "").toUpperCase();
  const state = (col || metaState || "IDLE") as FinancialOperationState;
  const owner = String(
    session?.financial_operation_owner ?? meta.financial_operation_owner ?? "",
  ).trim() || null;
  const startedRaw = session?.financial_operation_started_at
    ?? meta.financial_operation_started_at;
  const startedAtMs = startedRaw ? Date.parse(String(startedRaw)) : null;
  return {
    state: ["IDLE", "INCREMENTING", "CAPTURING", "RECONCILING", "RECOVERY_PENDING", "CAPTURED"]
        .includes(state)
      ? state
      : "IDLE",
    owner,
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null,
  };
}

function lockExpired(startedAtMs: number | null): boolean {
  if (startedAtMs == null) return true;
  return Date.now() - startedAtMs > LOCK_TTL_MS;
}

/**
 * Atomically claim a financial operation on the Payment Session.
 * Uses conditional update: only succeeds when state is IDLE (or lock expired).
 */
export async function claimPaymentSessionFinancialLock(
  supabase: SupabaseClient,
  args: {
    paymentSessionId: string;
    owner: string;
    state: Exclude<FinancialOperationState, "IDLE" | "CAPTURED">;
    operationKey?: string | null;
  },
): Promise<FinancialLockClaim> {
  const sessionId = String(args.paymentSessionId).trim();
  const owner = String(args.owner).trim();
  if (!sessionId || !owner) {
    return { ok: false, reason: "missing_session", currentState: null, currentOwner: null };
  }

  const { data: session, error } = await supabase
    .from("payment_sessions")
    .select(
      "id, metadata, financial_operation_state, financial_operation_owner, financial_operation_started_at",
    )
    .eq("id", sessionId)
    .maybeSingle();

  if (error || !session) {
    return { ok: false, reason: "missing_session", currentState: null, currentOwner: null };
  }

  const current = readLock(session as Record<string, unknown>);
  if (
    current.state !== "IDLE"
    && current.state !== "CAPTURED"
    && !lockExpired(current.startedAtMs)
    && current.owner !== owner
  ) {
    return {
      ok: false,
      reason: "busy",
      currentState: current.state,
      currentOwner: current.owner,
    };
  }
  if (current.state === "CAPTURED") {
    return {
      ok: false,
      reason: "busy",
      currentState: "CAPTURED",
      currentOwner: current.owner,
    };
  }

  const now = new Date().toISOString();
  const metadata = session.metadata && typeof session.metadata === "object"
    ? { ...(session.metadata as Record<string, unknown>) }
    : {};
  metadata.financial_operation_state = args.state;
  metadata.financial_operation_owner = owner;
  metadata.financial_operation_started_at = now;
  if (args.operationKey) metadata.financial_operation_key = args.operationKey;

  const patch: Record<string, unknown> = {
    metadata,
    financial_operation_state: args.state,
    financial_operation_owner: owner,
    financial_operation_started_at: now,
    updated_at: now,
  };

  const claimFilter: { sessionId: string; expectFinancialOperationOwner?: string } = {
    sessionId,
  };
  if (current.state !== "IDLE" && !lockExpired(current.startedAtMs) && current.owner === owner) {
    claimFilter.expectFinancialOperationOwner = owner;
  }

  const claim = await mutatePaymentSessionReturningId(
    supabase,
    claimFilter,
    patch,
    "financial_lock",
  );
  if (!claim.ok || !claim.id) {
    // Re-read for race
    const { data: again } = await supabase
      .from("payment_sessions")
      .select("financial_operation_state, financial_operation_owner")
      .eq("id", sessionId)
      .maybeSingle();
    return {
      ok: false,
      reason: "claim_failed",
      currentState: (again?.financial_operation_state as FinancialOperationState) ?? current.state,
      currentOwner: again?.financial_operation_owner
        ? String(again.financial_operation_owner)
        : current.owner,
    };
  }

  return { ok: true, owner, state: args.state };
}

export async function releasePaymentSessionFinancialLock(
  supabase: SupabaseClient,
  args: {
    paymentSessionId: string;
    owner: string;
    nextState?: "IDLE" | "CAPTURED" | "RECOVERY_PENDING";
  },
): Promise<void> {
  const sessionId = String(args.paymentSessionId).trim();
  const next = args.nextState ?? "IDLE";
  const { data: session } = await supabase
    .from("payment_sessions")
    .select("metadata, financial_operation_owner")
    .eq("id", sessionId)
    .maybeSingle();
  if (!session) return;
  if (
    session.financial_operation_owner
    && String(session.financial_operation_owner) !== args.owner
  ) {
    return;
  }
  const metadata = session.metadata && typeof session.metadata === "object"
    ? { ...(session.metadata as Record<string, unknown>) }
    : {};
  metadata.financial_operation_state = next;
  if (next === "IDLE") {
    delete metadata.financial_operation_owner;
    delete metadata.financial_operation_started_at;
    delete metadata.financial_operation_key;
  }
  await mutatePaymentSession(
    supabase,
    { sessionId, expectFinancialOperationOwner: args.owner },
    {
      metadata,
      financial_operation_state: next,
      financial_operation_owner: next === "IDLE" ? null : args.owner,
      financial_operation_started_at: next === "IDLE" ? null : new Date().toISOString(),
    },
    "financial_lock",
  );
}
