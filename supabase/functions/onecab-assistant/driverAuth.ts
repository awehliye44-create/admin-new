/**
 * Driver Assistant authentication contract.
 *
 * Website HMAC sessions are not sufficient. driver_app must validate the
 * Supabase JWT, resolve the Driver server-side, verify the active device,
 * and ignore any client-supplied driver id / role / ownership.
 */

export const DRIVER_ASSISTANT_BUSY_CODE = "DRIVER_ASSISTANT_UNAVAILABLE_DURING_TRIP";

export type DriverAssistantIdentity = {
  authUserId: string;
  driverId: string;
  firstName: string | null;
  installationId: string;
};

export type DriverAuthFailure =
  | "unauthorized"
  | "not_driver"
  | "device_replaced"
  | "busy_workflow";

export type DriverAuthResult =
  | { ok: true; identity: DriverAssistantIdentity }
  | { ok: false; reason: DriverAuthFailure };

export type AuthenticateDriver = (args: {
  jwt: string | null;
  installationId: unknown;
  clientDriverId: unknown;
  clientRole: unknown;
  clientStatus: unknown;
  clientDeviceOwner: unknown;
}) => Promise<DriverAuthResult>;

export function readBearerToken(authorization: string | null): string | null {
  if (!authorization) return null;
  const match = authorization.match(/^Bearer\s+(\S+)/i);
  const token = match?.[1]?.trim() ?? "";
  return token.length > 0 ? token : null;
}

export function readInstallationId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function driverAuthHttpStatus(reason: DriverAuthFailure): number {
  if (reason === "busy_workflow") return 409;
  if (reason === "unauthorized") return 401;
  return 403;
}

export function driverAuthErrorBody(reason: DriverAuthFailure): Record<string, unknown> {
  if (reason === "busy_workflow") {
    return { error: DRIVER_ASSISTANT_BUSY_CODE, reply: null };
  }
  return { error: "unauthorized", reply: null };
}
