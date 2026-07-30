/**
 * Phase 3 — route normal rebroadcast/booking recovery to auto-dispatch edge only.
 * SQL dispatch_trip_offers RPC is allowed only when dispatch_settings.manual_emergency_dispatch_only=true.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { loadDispatchSettings } from "./dispatch-settings.ts";

export const DISPATCH_SOURCE_TAGS = [
  "auto_dispatch",
  "auto_dispatch_stacked",
  "stacked_accept",
  "sql_dispatch_trip_offers",
  "decline_offer",
  "scheduled_dispatch",
  "manual_admin",
  "expire_offers",
  "customer_resume_driver_search",
  "driver_cancel_before_pickup",
] as const;

export type DispatchSourceTag = (typeof DISPATCH_SOURCE_TAGS)[number];

export type AutoDispatchInvokeBody = {
  trip_id: string;
  force_rebroadcast?: boolean;
  trigger_reason?: string;
  declined_driver_id?: string;
};

export type DispatchOrchestratorResult = {
  ok: boolean;
  path: "auto_dispatch" | "sql_dispatch_trip_offers" | "blocked";
  error?: string;
};

type InvokeClient = Pick<SupabaseClient, "rpc" | "functions">;

export function isManualEmergencyDispatchOnly(
  settings: Record<string, unknown>,
): boolean {
  return settings.manual_emergency_dispatch_only === true;
}

/** Pure: normal rebroadcast must not use SQL RPC when emergency flag is off. */
export function shouldUseSqlDispatchRpc(
  settings: Record<string, unknown>,
): boolean {
  return isManualEmergencyDispatchOnly(settings);
}

export async function invokeAutoDispatch(
  supabase: InvokeClient,
  body: AutoDispatchInvokeBody,
): Promise<DispatchOrchestratorResult> {
  try {
    const { error } = await supabase.functions.invoke("auto-dispatch", { body });
    if (error) {
      return { ok: false, path: "auto_dispatch", error: error.message };
    }
    return { ok: true, path: "auto_dispatch" };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, path: "auto_dispatch", error: message };
  }
}

/**
 * Retry auto-dispatch once after failure (expire-offers). No SQL fallback when flag is off.
 */
export async function invokeAutoDispatchWithRetry(
  supabase: InvokeClient,
  body: AutoDispatchInvokeBody,
  retries = 1,
): Promise<DispatchOrchestratorResult> {
  let last = await invokeAutoDispatch(supabase, body);
  for (let i = 0; i < retries && !last.ok; i++) {
    last = await invokeAutoDispatch(supabase, body);
  }
  return last;
}

export async function invokeSqlDispatchTripOffersIfAllowed(
  supabase: InvokeClient,
  tripId: string,
  serviceAreaId?: string | null,
): Promise<DispatchOrchestratorResult> {
  const settings = await loadDispatchSettings(supabase as SupabaseClient, serviceAreaId);
  if (!shouldUseSqlDispatchRpc(settings)) {
    return {
      ok: false,
      path: "blocked",
      error: "dispatch_trip_offers RPC disabled; enable manual_emergency_dispatch_only on global dispatch_settings",
    };
  }
  const { error } = await supabase.rpc("dispatch_trip_offers", { p_trip_id: tripId });
  if (error) {
    return { ok: false, path: "sql_dispatch_trip_offers", error: error.message };
  }
  return { ok: true, path: "sql_dispatch_trip_offers" };
}

/** Customer/driver recovery: auto-dispatch rebroadcast after trip reset. */
export async function rebroadcastTripViaAutoDispatch(
  supabase: InvokeClient,
  tripId: string,
  triggerReason: string,
): Promise<DispatchOrchestratorResult> {
  return invokeAutoDispatch(supabase, {
    trip_id: tripId,
    force_rebroadcast: true,
    trigger_reason: triggerReason,
  });
}
