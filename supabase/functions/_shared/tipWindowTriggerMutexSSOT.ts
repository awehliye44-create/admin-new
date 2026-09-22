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
  kind: "tip_authorisation_declined" | "capture_confirmed" | "capture_not_confirmed" | "provider_unknown";
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

export function newTipWindowClaimToken(): string {
  return crypto.randomUUID();
}

export { TIP_WINDOW_STATUS, TIP_WINDOW_TRIGGER };
