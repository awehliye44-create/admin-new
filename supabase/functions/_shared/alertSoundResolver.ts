/**
 * Resolves admin-managed alert sounds from `alert_sound_mappings` + `alert_sounds`.
 * Storage bucket `alert-sounds` is public — edge functions emit HTTPS URLs for native streaming.
 */

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

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
