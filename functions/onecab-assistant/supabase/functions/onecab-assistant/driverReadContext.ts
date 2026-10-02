/**
 * Server-resolved Driver Assistant context.
 * Never populated from client payload fields.
 */

export type DriverFinancialModel =
  | "PLATFORM_COLLECTED"
  | "DRIVER_COLLECTED_COMMISSION_WALLET"
  | "UNKNOWN";

export type DriverWorkflowHint =
  | "idle"
  | "active_trip"
  | "active_with_queue"
  | "queued_next";

export type DriverDocumentStateHint =
  | "documents_missing"
  | "documents_pending_review"
  | "documents_rejected"
  | "documents_expired"
  | "documents_approved"
  | "documents_uploaded"
  | null;

export type DriverReadContext = {
  financialModel: DriverFinancialModel;
  online: boolean | null;
  documentState: DriverDocumentStateHint;
  workflow: DriverWorkflowHint;
};

export const UNKNOWN_DRIVER_CONTEXT: DriverReadContext = {
  financialModel: "UNKNOWN",
  online: null,
  documentState: null,
  workflow: "idle",
};

const DOCUMENT_STATES = new Set<Exclude<DriverDocumentStateHint, null>>([
  "documents_missing",
  "documents_pending_review",
  "documents_rejected",
  "documents_expired",
  "documents_approved",
  "documents_uploaded",
]);

/** Fail closed. Empty or unpaired models are UNKNOWN — never implied platform payouts. */
export function resolveDriverFinancialModel(
  financialModel: unknown,
  commissionWalletEnabled: unknown,
): DriverFinancialModel {
  const model = String(financialModel ?? "").trim().toUpperCase();
  if (
    model === "DRIVER_COLLECTED_COMMISSION_WALLET" &&
    commissionWalletEnabled === true
  ) {
    return "DRIVER_COLLECTED_COMMISSION_WALLET";
  }
  if (model === "PLATFORM_COLLECTED") return "PLATFORM_COLLECTED";
  return "UNKNOWN";
}

export function readDocumentStateHint(value: unknown): DriverDocumentStateHint {
  const state = String(value ?? "").trim().toLowerCase();
  if (DOCUMENT_STATES.has(state as Exclude<DriverDocumentStateHint, null>)) {
    return state as Exclude<DriverDocumentStateHint, null>;
  }
  return null;
}

export function readOnlineHint(value: unknown): boolean | null {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}
