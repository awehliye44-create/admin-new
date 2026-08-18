/**
 * Customer Assistant authentication contract.
 *
 * Website HMAC sessions are not sufficient. customer_app must validate the
 * Supabase JWT, resolve the Customer server-side, verify the active device,
 * and ignore any client-supplied customer id / role / email / phone / ownership.
 */

export const CUSTOMER_ASSISTANT_BUSY_CODE = "CUSTOMER_ASSISTANT_UNAVAILABLE_DURING_TRIP";

export type CustomerAssistantIdentity = {
  authUserId: string;
  customerId: string;
  firstName: string | null;
  installationId: string;
};

export type CustomerAuthFailure =
  | "unauthorized"
  | "not_customer"
  | "device_replaced"
  | "busy_workflow";

export type CustomerAuthResult =
  | { ok: true; identity: CustomerAssistantIdentity }
  | { ok: false; reason: CustomerAuthFailure };

export type AuthenticateCustomer = (args: {
  jwt: string | null;
  installationId: unknown;
  clientCustomerId: unknown;
  clientRole: unknown;
  clientEmail: unknown;
  clientPhone: unknown;
  clientDeviceOwner: unknown;
}) => Promise<CustomerAuthResult>;

export function customerAuthHttpStatus(reason: CustomerAuthFailure): number {
  if (reason === "busy_workflow") return 409;
  if (reason === "unauthorized") return 401;
  return 403;
}

export function customerAuthErrorBody(reason: CustomerAuthFailure): Record<string, unknown> {
  if (reason === "busy_workflow") {
    return { error: CUSTOMER_ASSISTANT_BUSY_CODE, reply: null };
  }
  return { error: "unauthorized", reply: null };
}
