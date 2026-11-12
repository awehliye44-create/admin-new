/**
 * Phase 5 — per-device capability gate for departure acknowledgement.
 *
 * Global scheduled_departure_ack_enabled alone is insufficient.
 * Arm arm_ack only when the driver's *sole active* installation
 * (`driver_active_devices`) advertises the capability token that the *loaded*
 * Driver JS/OTA sent on bind. Never infer capability from native app_version /
 * runtimeVersion alone — an older OTA on the same native binary must stay on
 * Phase 4 exclusive NRO (`ack_nro`).
 *
 * Push delivery (`resolveDriverAuthoritativeToken`) uses the same active
 * device_id, so notification recipient and capability decision stay aligned.
 *
 * Bind always replaces `client_capabilities` (missing body → []). OTA adopt
 * rebinds with the new token; rollback OTA rebinds without it and clears.
 */

/** Legacy token — older OTAs may still advertise; never grants Phase 5 once key=v2. */
export const SCHEDULED_DEPARTURE_ACK_CAPABILITY_V1 = "scheduled_departure_ack_v1" as const;

/**
 * Hydration-corrected scheduled activation OTA (Driver 6b42821 lineage +).
 * Production Phase 5 gate requires this token on the sole active device.
 */
export const SCHEDULED_DEPARTURE_ACK_CAPABILITY_V2 =
  "scheduled_departure_ack_v2" as const;

export type DepartureAckCapabilityConfig = {
  globalEnabled: boolean;
  capabilityKey: string;
  minAppVersion: string | null;
};

export type DriverClientCapabilitySnapshot = {
  capabilities: string[];
  /** Informational only — never grants capability by itself. */
  appVersion: string | null;
  /** Sole active installation id (matches authoritative push device_id). */
  deviceId: string | null;
};

/** Parse semver-ish "1.0.6" / "1.0.6(64)" → [1,0,6]. Non-numeric → null. */
export function parseLooseSemver(raw: string | null | undefined): number[] | null {
  if (raw == null) return null;
  const head = String(raw).trim().split(/[^\d.]/)[0] ?? "";
  if (!head) return null;
  const parts = head.split(".").map((p) => parseInt(p, 10));
  if (!parts.length || parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  return parts;
}

export function isAppVersionAtLeast(
  actual: string | null | undefined,
  minimum: string | null | undefined,
): boolean {
  if (minimum == null || String(minimum).trim() === "") return true;
  const a = parseLooseSemver(actual);
  const m = parseLooseSemver(minimum);
  if (!a || !m) return false;
  const len = Math.max(a.length, m.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const mv = m[i] ?? 0;
    if (av > mv) return true;
    if (av < mv) return false;
  }
  return true;
}

export function normalizeCapabilityList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .map((x) => String(x ?? "").trim().toLowerCase())
      .filter(Boolean);
  }
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return normalizeCapabilityList(parsed);
    } catch {
      return [raw.trim().toLowerCase()];
    }
  }
  return [];
}

export function resolveDepartureAckCapabilityConfig(
  row: Record<string, unknown> | null | undefined,
): DepartureAckCapabilityConfig {
  const enabledRaw = row?.scheduled_departure_ack_enabled;
  let globalEnabled = false;
  if (typeof enabledRaw === "boolean") globalEnabled = enabledRaw;
  else if (enabledRaw != null && enabledRaw !== "") {
    const v = String(enabledRaw).trim().toLowerCase();
    globalEnabled = v === "true" || v === "1" || v === "yes";
  }
  const key = String(
    row?.scheduled_departure_ack_capability_key ??
      SCHEDULED_DEPARTURE_ACK_CAPABILITY_V2,
  ).trim() || SCHEDULED_DEPARTURE_ACK_CAPABILITY_V2;
  const minRaw = row?.scheduled_departure_ack_min_app_version;
  const minAppVersion =
    minRaw == null || String(minRaw).trim() === ""
      ? null
      : String(minRaw).trim();
  return { globalEnabled, capabilityKey: key, minAppVersion };
}

/**
 * True only when global flag is on AND active device advertises the capability
 * token AND optional min app version floor is satisfied.
 *
 * app_version alone never grants support — capability token is mandatory.
 */
export function driverSupportsDepartureAck(input: {
  config: DepartureAckCapabilityConfig;
  snapshot: DriverClientCapabilitySnapshot | null;
}): { supported: boolean; reason: string } {
  if (!input.config.globalEnabled) {
    return { supported: false, reason: "global_flag_disabled" };
  }
  if (!input.snapshot) {
    return { supported: false, reason: "no_active_device_capability" };
  }
  if (!input.snapshot.deviceId) {
    return { supported: false, reason: "no_active_device_id" };
  }
  const key = input.config.capabilityKey.trim().toLowerCase();
  const caps = input.snapshot.capabilities.map((c) => c.toLowerCase());
  if (!caps.includes(key)) {
    return { supported: false, reason: "capability_missing" };
  }
  // Optional floor only AFTER the OTA-advertised token is present.
  if (
    !isAppVersionAtLeast(input.snapshot.appVersion, input.config.minAppVersion)
  ) {
    return { supported: false, reason: "app_version_below_minimum" };
  }
  return { supported: true, reason: "ok" };
}

/** Resolve execution mode for a specific confirmed driver installation. */
export function resolveDepartureAckExecutionModeForDriver(input: {
  config: DepartureAckCapabilityConfig;
  snapshot: DriverClientCapabilitySnapshot | null;
}): "departure_ack" | "ack_nro" {
  return driverSupportsDepartureAck(input).supported
    ? "departure_ack"
    : "ack_nro";
}
