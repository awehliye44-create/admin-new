/** Offline test/audit-only helpers; not part of Edge uploads. */
import { isDriverWalletAdjustmentRejectedStaffRole, isDriverWalletAdjustmentFinanceRole, isDriverWalletAdminAdjustmentLedgerType, buildDriverWalletManualAdjustmentIdempotencyKey } from "../../../functions/_shared/driverWalletManualAdjustmentSSOT.ts";


/**
 * Auth matrix for edge callers (mirrors requireFinanceExecutionAuth + requireStaffFinanceProfile).
 * Legacy user_roles.admin without staff_profiles finance role is rejected.
 */
export function evaluateDriverWalletAdjustmentCallerAccess(args: {
  authenticated: boolean;
  hasStaffFinanceProfile: boolean;
  staffRole: string | null | undefined;
}): { ok: true; role: string } | { ok: false; code: string } {
  if (!args.authenticated) {
    return { ok: false, code: "UNAUTHENTICATED" };
  }
  if (!args.hasStaffFinanceProfile) {
    return { ok: false, code: "FINANCE_STAFF_PROFILE_REQUIRED" };
  }
  const role = String(args.staffRole ?? "").trim();
  if (isDriverWalletAdjustmentRejectedStaffRole(role)) {
    return { ok: false, code: "FINANCE_EXECUTION_FORBIDDEN" };
  }
  if (!isDriverWalletAdjustmentFinanceRole(role)) {
    return { ok: false, code: "FINANCE_EXECUTION_FORBIDDEN" };
  }
  return { ok: true, role };
}


/** RLS-shaped own-row check for applied adjustment ledger visibility. */
export function canDriverSelectOwnAdminAdjustmentLedgerRow(args: {
  viewerDriverId: string | null | undefined;
  rowDriverId: string | null | undefined;
  ledgerType: string | null | undefined;
}): boolean {
  const viewer = String(args.viewerDriverId ?? "").trim();
  const rowDriver = String(args.rowDriverId ?? "").trim();
  if (!viewer || !rowDriver || viewer !== rowDriver) return false;
  return isDriverWalletAdminAdjustmentLedgerType(args.ledgerType);
}


/** Client must never INSERT ledger rows; only service_role / edge. */
export function canAuthenticatedClientInsertDriverWalletLedger(): boolean {
  return false;
}


/**
 * Concurrent/idempotent apply simulator — unique provider_transfer_id wins once.
 * Models dw_manual_adj:% unique index + 23505 duplicate handling.
 */
export function simulateConcurrentManualAdjustmentLedgerPosts(args: {
  idempotencyKey: string;
  ledgerType: string;
  attempts: number;
}): { posted: number; ledgerTypes: string[]; rejectedDuplicates: number } {
  const key = buildDriverWalletManualAdjustmentIdempotencyKey(args.idempotencyKey);
  const type = String(args.ledgerType ?? "").toUpperCase();
  if (type === "TRIP_EARNING_NET") {
    throw new Error("MANUAL_ADJUSTMENT_MUST_NOT_USE_TRIP_EARNING_NET");
  }
  if (!isDriverWalletAdminAdjustmentLedgerType(type)) {
    throw new Error("MANUAL_ADJUSTMENT_INVALID_LEDGER_TYPE");
  }
  const seen = new Set<string>();
  const ledgerTypes: string[] = [];
  let rejectedDuplicates = 0;
  const n = Math.max(0, Math.floor(args.attempts));
  for (let i = 0; i < n; i++) {
    if (seen.has(key)) {
      rejectedDuplicates += 1;
      continue;
    }
    seen.add(key);
    ledgerTypes.push(type);
  }
  return { posted: ledgerTypes.length, ledgerTypes, rejectedDuplicates };
}


/** Internal/admin direction label for audit UI (not shown as driver primary title). */
export function driverWalletAdjustmentAdminDirectionLabel(
  direction: "CREDIT" | "DEBIT",
): string {
  return direction === "CREDIT" ? "Credit" : "Debit";
}

export * from "../../../functions/_shared/driverWalletManualAdjustmentSSOT.ts";
export * from "../../../../shared/edgePresentation/driverWalletManualAdjustmentSSOT.ts";
