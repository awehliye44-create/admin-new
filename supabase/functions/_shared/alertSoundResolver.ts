/**
 * Resolves admin-managed alert sounds from `alert_sound_mappings` + `alert_sounds`.
 * Storage bucket `alert-sounds` is public — edge functions emit HTTPS URLs for native streaming.
 */

import type { SupabaseClient } from "npm:@supabase/supabase-js@2.49.4";

export type AlertSoundTargetApp = "driver" | "customer";

export interface ResolvedAlertSound {
  eventType: string;
  storagePath: string;
  publicUrl: string;
  soundName: string;
}

const BUCKET = "alert-sounds";

export function buildPublicAlertSoundUrl(supabaseUrl: string, storagePath: string): string {
  const base = supabaseUrl.replace(/\/+$/, "");
  const path = storagePath.replace(/^\/+/, "");
  return `${base}/storage/v1/object/public/${BUCKET}/${path}`;
}

export async function resolveAlertSound(
  supabase: SupabaseClient,
  targetApp: AlertSoundTargetApp,
  eventType: string,
  supabaseUrl: string,
): Promise<ResolvedAlertSound | null> {
  const { data, error } = await supabase
    .from("alert_sound_mappings")
    .select(`
      event_type,
      is_active,
      alert_sounds:alert_sound_id (
        name,
        storage_path,
        is_active
      )
    `)
    .eq("target_app", targetApp)
    .eq("event_type", eventType)
    .eq("is_active", true)
    .maybeSingle();

  if (error) {
    console.warn(`[alertSoundResolver] query failed ${targetApp}/${eventType}:`, error.message);
    return null;
  }
  if (!data) return null;

  const sound = data.alert_sounds as {
    name?: string;
    storage_path?: string;
    is_active?: boolean;
  } | null;

  if (!sound?.is_active || !sound.storage_path) return null;

  return {
    eventType,
    storagePath: sound.storage_path,
    publicUrl: buildPublicAlertSoundUrl(supabaseUrl, sound.storage_path),
    soundName: sound.name ?? eventType,
  };
}

/** Trip push events → admin customer alert_sound_mappings event_type. */
export const TRIP_EVENT_SOUND_MAP: Record<string, string> = {
  driver_assigned: "driver_assigned",
  trip_accepted: "driver_assigned",
  new_driver_assigned: "driver_assigned",
  stacked_driver_assigned: "driver_assigned",
  driver_approaching: "driver_assigned",
  driver_arrived: "driver_arrived",
  waiting_started: "driver_arrived",
  trip_started: "trip_started",
  traffic_delay: "general_notification",
  route_changed: "general_notification",
  safety_reminder: "general_notification",
  fare_updated: "payment_status",
  trip_completed: "trip_completed",
  trip_cancelled: "trip_cancelled",
  no_show: "trip_cancelled",
  rating_request: "trip_completed",
  payment_success: "payment_status",
  payment_failed: "payment_status",
  lost_item_followup: "general_notification",
  customer_new_fare_offer: "general_notification",
  driver_accepted_counter: "general_notification",
  finding_another_driver_updated_fare: "general_notification",
  negotiation_offer_expired: "general_notification",
  driver_cancelled: "general_notification",
};
