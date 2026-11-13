/**
 * OTA adoption telemetry (Driver + Customer active-device bind).
 *
 * Fields describe the CURRENTLY LOADED Expo update (Updates.updateId), not a
 * downloaded/available one. Always replaced on bind — missing/invalid → null
 * so older apps and rollbacks clear stale values. Telemetry only: never used
 * to force an OTA reload.
 */

export interface OtaAdoptionTelemetry {
  loaded_update_id: string | null;
  update_is_embedded: boolean | null;
  runtime_version: string | null;
  loaded_update_registered_at: string | null;
}

const MAX_ID_LEN = 80;
const MAX_RUNTIME_LEN = 64;

function cleanString(raw: unknown, max: number): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  return t ? t.slice(0, max) : null;
}

function cleanBool(raw: unknown): boolean | null {
  if (typeof raw === "boolean") return raw;
  if (raw === "true" || raw === 1 || raw === "1") return true;
  if (raw === "false" || raw === 0 || raw === "0") return false;
  return null;
}

export function normalizeOtaAdoptionTelemetry(
  body: Record<string, unknown> | null | undefined,
  nowIso: string,
): OtaAdoptionTelemetry {
  const loaded_update_id = cleanString(body?.loaded_update_id, MAX_ID_LEN);
  const update_is_embedded = cleanBool(body?.update_is_embedded);
  const runtime_version = cleanString(body?.runtime_version, MAX_RUNTIME_LEN);
  const reported = loaded_update_id !== null || update_is_embedded !== null ||
    runtime_version !== null;
  return {
    loaded_update_id,
    update_is_embedded,
    runtime_version,
    loaded_update_registered_at: reported ? nowIso : null,
  };
}

/**
 * Exact driver_active_devices upsert row written by bind-driver-device-token.
 * Extracted so field mapping is execution-testable without booting the Edge server.
 */
export function buildDriverActiveDeviceUpsertRow(input: {
  driverId: string;
  installationId: string;
  platform: string;
  nowIso: string;
  appVersion: string | null;
  clientCapabilities: string[];
  ota: OtaAdoptionTelemetry;
}): Record<string, unknown> {
  return {
    driver_id: input.driverId,
    device_id: input.installationId,
    platform: input.platform,
    last_seen_at: input.nowIso,
    updated_at: input.nowIso,
    app_version: input.appVersion,
    client_capabilities: input.clientCapabilities,
    client_capabilities_updated_at: input.nowIso,
    ...input.ota,
  };
}
