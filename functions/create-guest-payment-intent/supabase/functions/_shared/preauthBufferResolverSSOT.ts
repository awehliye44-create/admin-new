/**
 * Pre-Authorization Buffer SSOT — per-service-area admin config
 * (public.service_area_preauth_settings) is the SOLE source of truth.
 *
 * hold = payable fare + server-resolved buffer.
 * The buffer is authorisation headroom only: never fare, never revenue,
 * never captured automatically. Clients must never supply or override it.
 *
 * Shared by create-preauth-payment-intent (no-quote path) and
 * customer-receivable-booking-quote (opaque quote freeze).
 */

export type PreauthBufferSettingsRow = {
  enable_preauth_buffer?: unknown;
  buffer_type?: unknown;
  buffer_value?: unknown;
  min_hold_pence?: unknown;
  max_hold_pence?: unknown;
};

export type PreauthBufferSource = {
  service_area_id: string | null;
  enable_preauth_buffer: boolean;
  buffer_type: string;
  buffer_value: number;
  min_hold_pence: number | null;
  max_hold_pence: number | null;
  config_table: string;
};

export type PreauthBufferResolution = {
  bufferPence: number;
  source: PreauthBufferSource;
};

export const PREAUTH_BUFFER_CONFIG_TABLE = "public.service_area_preauth_settings";

/** Pure buffer computation from a settings row (null row → no buffer). */
export function computeServiceAreaPreauthBuffer(
  cfg: PreauthBufferSettingsRow | null,
  estimatedTotalPence: number,
  serviceAreaId: string | null,
  options?: { skipMinHoldWhenDiscounted?: boolean },
): PreauthBufferResolution {
  const enabled = !!cfg?.enable_preauth_buffer;
  const bufferType = (cfg?.buffer_type as string) ?? "none";
  const bufferValue = Number(cfg?.buffer_value ?? 0);
  const minHold = cfg?.min_hold_pence == null ? null : Number(cfg.min_hold_pence);
  const maxHold = cfg?.max_hold_pence == null ? null : Number(cfg.max_hold_pence);

  let rawBufferPence = 0;
  if (enabled && bufferValue > 0) {
    if (bufferType === "fixed") {
      // buffer_value is stored in the major currency unit (e.g. £1.00)
      rawBufferPence = Math.round(bufferValue * 100);
    } else if (bufferType === "percentage") {
      // e.g. buffer_value = 20 → 20%
      rawBufferPence = Math.ceil((estimatedTotalPence * bufferValue) / 100);
    }
  }

  // Apply optional min / max hold clamps to the FINAL hold (estimate + buffer).
  // When a promo discount applies, skip min_hold so we do not bump the hold up
  // to a "minimum fare" floor (customer should be authorised at discounted + buffer only).
  const skipMin = options?.skipMinHoldWhenDiscounted === true;
  let finalHoldPence = estimatedTotalPence + rawBufferPence;
  if (!skipMin && minHold != null && finalHoldPence < minHold) finalHoldPence = minHold;
  if (maxHold != null && finalHoldPence > maxHold) finalHoldPence = maxHold;
  const bufferPence = Math.max(0, finalHoldPence - estimatedTotalPence);

  return {
    bufferPence,
    source: {
      service_area_id: serviceAreaId,
      config_table: PREAUTH_BUFFER_CONFIG_TABLE,
      enable_preauth_buffer: enabled,
      buffer_type: bufferType,
      buffer_value: bufferValue,
      min_hold_pence: minHold,
      max_hold_pence: maxHold,
    },
  };
}

/**
 * Resolve the buffer for a service area. No service area → no buffer.
 * Returns the computed buffer in pence plus the config snapshot used so it
 * can be logged/persisted for auditability.
 */
export async function resolvePreauthBuffer(
  // deno-lint-ignore no-explicit-any
  supabaseClient: any,
  estimatedTotalPence: number,
  serviceAreaId: string | null,
  options?: { skipMinHoldWhenDiscounted?: boolean },
): Promise<PreauthBufferResolution> {
  if (!serviceAreaId) {
    return {
      bufferPence: 0,
      source: {
        service_area_id: serviceAreaId,
        config_table: PREAUTH_BUFFER_CONFIG_TABLE,
        enable_preauth_buffer: false,
        buffer_type: "none",
        buffer_value: 0,
        min_hold_pence: null,
        max_hold_pence: null,
      },
    };
  }

  const { data: rawCfg, error } = await supabaseClient
    .from("service_area_preauth_settings")
    .select("enable_preauth_buffer, buffer_type, buffer_value, min_hold_pence, max_hold_pence")
    .eq("service_area_id", serviceAreaId)
    .maybeSingle();

  if (error) {
    console.warn("[PREAUTH-BUFFER] Failed to load preauth settings", error);
  }

  return computeServiceAreaPreauthBuffer(
    rawCfg as PreauthBufferSettingsRow | null,
    estimatedTotalPence,
    serviceAreaId,
    options,
  );
}
