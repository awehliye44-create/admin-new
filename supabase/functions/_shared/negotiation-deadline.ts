/**
 * Preset negotiation response deadline.
 * SSOT: preset_offer_configs.countdown_seconds for the trip's service area.
 * Same duration for Driver→Customer (£Y) and Customer→Driver (£Z).
 * countdown_enabled is a display toggle only — it never changes the window.
 * Never auto-accept on expiry.
 */
import { normalizeCountdownSeconds } from "./presetNegotiationEligibility.ts";

/** Column default on preset_offer_configs.countdown_seconds — last-resort only. */
export const PRESET_COUNTDOWN_SECONDS_FALLBACK = 30;

export function resolveNegotiationCountdownSeconds(config: {
  countdown_enabled?: boolean | null;
  countdown_seconds?: number | null;
} | null | undefined): number | null {
  if (!config) return null;
  return normalizeCountdownSeconds(config.countdown_seconds);
}

export function clampNegotiationCountdownSeconds(raw: unknown): number {
  return normalizeCountdownSeconds(raw) ?? PRESET_COUNTDOWN_SECONDS_FALLBACK;
}

/** Absolute server deadline from Admin duration. */
export function negotiationDeadlineIso(seconds: number, fromMs = Date.now()): string {
  return new Date(fromMs + clampNegotiationCountdownSeconds(seconds) * 1000).toISOString();
}

export function resolveNegotiationDeadlineIso(args: {
  countdownSeconds: number | null;
  fromMs?: number;
}): string {
  const fromMs = args.fromMs ?? Date.now();
  return negotiationDeadlineIso(
    args.countdownSeconds ?? PRESET_COUNTDOWN_SECONDS_FALLBACK,
    fromMs,
  );
}

export async function loadServiceAreaNegotiationCountdown(
  supabase: { from: (table: string) => any },
  serviceAreaId: string | null | undefined,
): Promise<number | null> {
  if (!serviceAreaId) return null;
  const { data } = await supabase
    .from("preset_offer_configs")
    .select("countdown_seconds")
    .eq("service_area_id", serviceAreaId)
    .maybeSingle();
  return resolveNegotiationCountdownSeconds(
    data as {
      countdown_seconds?: number | null;
    } | null,
  );
}

/** Remaining whole seconds until an absolute deadline. No hardcoded cap. */
export function calcNegotiationRemainingSec(
  negotiationExpiresAt: string | null | undefined,
  nowMs = Date.now(),
): number {
  if (!negotiationExpiresAt) return 0;
  return Math.max(
    0,
    Math.ceil((new Date(negotiationExpiresAt).getTime() - nowMs) / 1000),
  );
}
