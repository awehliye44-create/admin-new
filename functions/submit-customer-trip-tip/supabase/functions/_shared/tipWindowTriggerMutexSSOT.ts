/**
 * Tip-window trigger mutex — Edge wrappers around claim/release/finalize RPCs.
 * Pure TypeScript winner calculation is not sufficient; these hit Postgres.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import {
  TIP_WINDOW_STATUS,
  TIP_WINDOW_TRIGGER,
  tipWindowTerminalStatusForTrigger,
  type TipWindowTrigger,
} from "./tipWindowConstants.ts";

export type TipWindowClaimResult =
  | {
    ok: true;
    claimed: true;
    idempotent: boolean;
    claimToken: string;
    trigger: TipWindowTrigger;
  }
  | {
    ok: false;
    code: string;
    tipWindowStatus?: string | null;
    tipWindowTrigger?: string | null;
    tipWindowClaimedAt?: string | null;
    tipWindowCaptureIdempotencyKey?: string | null;
    staleEligible?: boolean;
  };

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

export async function claimTipWindowTrigger(
  supabase: SupabaseClient,
  args: {
    tripId: string;
    trigger: TipWindowTrigger;
    claimToken: string;
    nowIso?: string;
  },
): Promise<TipWindowClaimResult> {
  const { data, error } = await supabase.rpc("claim_tip_window_trigger", {
    p_trip_id: args.tripId,
    p_trigger: args.trigger,
    p_claim_token: args.claimToken,
    p_now: args.nowIso ?? new Date().toISOString(),
  });
  if (error) {
    return { ok: false, code: "CLAIM_RPC_FAILED" };
  }
  const row = asRecord(data);
  if (row.ok === true && row.claimed === true) {
    return {
      ok: true,
      claimed: true,
      idempotent: row.idempotent === true,
      claimToken: String(row.claim_token ?? args.claimToken),
      trigger: String(row.tip_window_trigger ?? args.trigger) as TipWindowTrigger,
    };
  }
  return {
    ok: false,
    code: String(row.code ?? "CLAIM_DENIED"),
    tipWindowStatus: row.tip_window_status == null ? null : String(row.tip_window_status),
    tipWindowTrigger: row.tip_window_trigger == null
      ? null
      : String(row.tip_window_trigger),
    tipWindowClaimedAt: row.tip_window_claimed_at == null
      ? null
      : String(row.tip_window_claimed_at),
    tipWindowCaptureIdempotencyKey: row.tip_window_capture_idempotency_key == null
      ? null
      : String(row.tip_window_capture_idempotency_key),
    staleEligible: row.stale_eligible === true,
  };
}

export async function releaseTipWindowTriggerClaim(
  supabase: SupabaseClient,
  args: {
    tripId: string;
    claimToken: string;
    clearTip?: boolean;
    nowIso?: string;
  },
): Promise<{ ok: boolean; released?: boolean; code?: string }> {
  const { data, error } = await supabase.rpc("release_tip_window_trigger_claim", {
    p_trip_id: args.tripId,
    p_claim_token: args.claimToken,
    p_clear_tip: args.clearTip !== false,
    p_now: args.nowIso ?? new Date().toISOString(),
  });
  if (error) return { ok: false, code: "RELEASE_RPC_FAILED" };
  const row = asRecord(data);
  return {
    ok: row.ok === true,
    released: row.released === true,
    code: row.code == null ? undefined : String(row.code),
  };
}

export async function finalizeTipWindowTrigger(
  supabase: SupabaseClient,
  args: {
    tripId: string;
    claimToken: string;
    trigger: TipWindowTrigger;
    tipPence: number;
    nowIso?: string;
  },
): Promise<{ ok: boolean; finalized?: boolean; code?: string; tipWindowStatus?: string }> {
  const terminal = tipWindowTerminalStatusForTrigger(args.trigger);
  const { data, error } = await supabase.rpc("finalize_tip_window_trigger", {
    p_trip_id: args.tripId,
    p_claim_token: args.claimToken,
    p_terminal_status: terminal,
    p_tip_pence: Math.max(0, Math.round(args.tipPence)),
    p_now: args.nowIso ?? new Date().toISOString(),
  });
  if (error) return { ok: false, code: "FINALIZE_RPC_FAILED" };
  const row = asRecord(data);
  return {
    ok: row.ok === true,
    finalized: row.finalized === true,
    code: row.code == null ? undefined : String(row.code),
    tipWindowStatus: row.tip_window_status == null
      ? undefined
      : String(row.tip_window_status),
  };
}

/**
 * After tip-window finalize invoke: classify tip-auth decline vs capture-not-confirmed
 * vs confirmed capture. Tip-auth decline must never be treated as capture success.
 */
export function classifyTipWindowCaptureOutcome(
  body: Record<string, unknown> | null | undefined,
): {
  kind: "tip_authorisation_declined" | "tip_not_collected" | "capture_confirmed" | "capture_not_confirmed" | "provider_unknown";
  status: string;
} {
  const status = String(body?.status ?? "").trim();
  const statusUpper = status.toUpperCase();
  const errorCode = String(body?.error_code ?? body?.code ?? "").trim().toUpperCase();
  if (
    statusUpper === "TIP_AUTHORISATION_DECLINED"
    || errorCode === "TIP_AUTHORISATION_DECLINED"
  ) {
    return { kind: "tip_authorisation_declined", status };
  }
  if (
    statusUpper === "TIP_NOT_COLLECTED"
    || errorCode === "TIP_NOT_COLLECTED"
  ) {
    return { kind: "tip_not_collected", status };
  }


  const providerState = String(
    body?.provider_state
      ?? body?.providerState
      ?? body?.revolut_state
      ?? body?.provider_capture_status
      ?? "",
  ).trim().toUpperCase();

  if (
    providerState === "UNKNOWN"
    || statusUpper === "CAPTURE_UNKNOWN"
    || statusUpper === "PROVIDER_UNKNOWN"
    || statusUpper.includes("UNKNOWN")
  ) {
    return { kind: "provider_unknown", status };
  }

  const captured = Number(body?.capture_amount_pence ?? body?.captureAmountPence);
  if (
    body?.success !== false
    && Number.isFinite(captured)
    && captured > 0
    && (providerState === "COMPLETED" || providerState === "CAPTURED"
      || ["captured", "already_captured", "completed"].includes(status.toLowerCase()))
  ) {
    return { kind: "capture_confirmed", status };
  }

  if (providerState === "AUTHORISED" || providerState === "AUTHORIZED") {
    return { kind: "capture_not_confirmed", status };
  }

  return { kind: "capture_not_confirmed", status };
}

/**
 * MK-260926-001: tip>0 + fare already captured (tip_collected=0 / tip_shortfall>0)
 * must refuse — never seal CUSTOMER_SUBMIT_WITH_TIP at tip=0.
 */
export function tipRequestedButNotCollected(args: {
  requestedTipPence: number;
  body: Record<string, unknown> | null | undefined;
}): boolean {
  const requested = Math.max(0, Math.round(Number(args.requestedTipPence) || 0));
  if (requested <= 0) return false;
  const collected = Math.round(Number(args.body?.tip_collected_pence ?? NaN));
  if (Number.isFinite(collected) && collected >= requested) return false;
  const shortfall = Math.round(Number(args.body?.tip_shortfall_pence ?? NaN));
  if (Number.isFinite(shortfall) && shortfall > 0) return true;
  // Missing / zero collected after a tip request = refuse (fail closed).
  if (!Number.isFinite(collected) || collected <= 0) return true;
  return collected < requested;
}

export function newTipWindowClaimToken(): string {
  return crypto.randomUUID();
}

export async function stampTipWindowCaptureIdempotencyKey(
  supabase: SupabaseClient,
  args: {
    tripId: string;
    claimToken: string;
    idempotencyKey: string;
    nowIso?: string;
  },
): Promise<{ ok: boolean; key?: string; code?: string }> {
  const { data, error } = await supabase.rpc("stamp_tip_window_capture_idempotency_key", {
    p_trip_id: args.tripId,
    p_claim_token: args.claimToken,
    p_idempotency_key: args.idempotencyKey,
    p_now: args.nowIso ?? new Date().toISOString(),
  });
  if (error) return { ok: false, code: "STAMP_RPC_FAILED" };
  const row = asRecord(data);
  if (row.ok !== true) return { ok: false, code: String(row.code ?? "STAMP_DENIED") };
  return {
    ok: true,
    key: String(row.tip_window_capture_idempotency_key ?? args.idempotencyKey),
  };
}

export async function finalizeTipWindowExpiredAfterProviderCapture(
  supabase: SupabaseClient,
  args: { tripId: string; tipPence?: number; nowIso?: string },
): Promise<{ ok: boolean; tipWindowStatus?: string; code?: string }> {
  const { data, error } = await supabase.rpc(
    "finalize_tip_window_expired_after_provider_capture",
    {
      p_trip_id: args.tripId,
      p_tip_pence: Math.max(0, Math.round(args.tipPence ?? 0)),
      p_now: args.nowIso ?? new Date().toISOString(),
    },
  );
  if (error) return { ok: false, code: "FINALIZE_PROVIDER_RPC_FAILED" };
  const row = asRecord(data);
  return {
    ok: row.ok === true,
    tipWindowStatus: row.tip_window_status == null
      ? undefined
      : String(row.tip_window_status),
    code: row.code == null ? undefined : String(row.code),
  };
}

/**
 * MK-260926-001: after confirmed fare capture with tip=0 / tip not collected,
 * seal the tip window CLOSED so Rate Trip stops showing tip stepper/timer.
 * Idempotent when already closed. Does not require a mutex claim token.
 */
export async function closeOpenTipWindowAfterFareCapture(
  supabase: SupabaseClient,
  args: {
    tripId: string;
    tipPence?: number;
    nowIso?: string;
  },
): Promise<{ ok: boolean; closed?: boolean }> {
  const nowIso = args.nowIso ?? new Date().toISOString();
  const tipPence = Math.max(0, Math.round(Number(args.tipPence) || 0));
  const { data, error } = await supabase
    .from("trips")
    .update({
      tip_amount_pence: tipPence,
      tip_pence: tipPence,
      tip_window_closed_at: nowIso,
      tip_window_status: TIP_WINDOW_STATUS.CLOSED,
      tip_window_claim_token: null,
      tip_window_trigger: null,
      tip_window_claimed_at: null,
      updated_at: nowIso,
    })
    .eq("id", args.tripId)
    .not("tip_window_expires_at", "is", null)
    .is("tip_window_closed_at", null)
    .select("id")
    .maybeSingle();
  if (error) return { ok: false };
  return { ok: true, closed: Boolean(data?.id) };
}

export async function reclaimStaleTipWindowExpiryAfterAuthorisedGet(
  supabase: SupabaseClient,
  args: { tripId: string; claimToken: string; nowIso?: string },
): Promise<
  | { ok: true; claimToken: string; idempotencyKey: string | null }
  | { ok: false; code: string }
> {
  const { data, error } = await supabase.rpc(
    "reclaim_stale_tip_window_expiry_after_authorised_get",
    {
      p_trip_id: args.tripId,
      p_new_claim_token: args.claimToken,
      p_now: args.nowIso ?? new Date().toISOString(),
    },
  );
  if (error) return { ok: false, code: "RECLAIM_RPC_FAILED" };
  const row = asRecord(data);
  if (row.ok !== true) return { ok: false, code: String(row.code ?? "RECLAIM_DENIED") };
  return {
    ok: true,
    claimToken: String(row.claim_token ?? args.claimToken),
    idempotencyKey: row.tip_window_capture_idempotency_key == null
      ? null
      : String(row.tip_window_capture_idempotency_key),
  };
}

export { TIP_WINDOW_STATUS, TIP_WINDOW_TRIGGER };
