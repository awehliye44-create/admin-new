/**
 * Admin shared-vehicle assign / return / reactivate / set-active / suspend /
 * archive and document vehicle-link resolve / soft-retire.
 * List/compliance reads: 20270305130000 (page-gated; no direct table).
 * Server SSOT: migrations 20270305100000–20270305130000.
 */

import { supabase } from '@/integrations/supabase/client';

type RpcOk = { ok?: boolean; code?: string; [key: string]: unknown };

async function callRpc(
  name: string,
  args: Record<string, unknown>,
): Promise<{ ok: true; data: RpcOk } | { ok: false; code: string; message: string }> {
  const { data, error } = await supabase.rpc(name as never, args as never);
  if (error) {
    return { ok: false, code: 'NETWORK_ERROR', message: error.message };
  }
  const payload = (data ?? {}) as RpcOk;
  if (payload.ok !== true) {
    const code = typeof payload.code === 'string' ? payload.code : 'UNKNOWN';
    return { ok: false, code, message: adminVehicleLifecycleMessage(code) };
  }
  return { ok: true, data: payload };
}

export function adminVehicleLifecycleMessage(code: string): string {
  switch (code) {
    case 'NOT_AVAILABLE_IN_FLEET':
      return 'This vehicle is not available in the fleet.';
    case 'ALREADY_ASSIGNED':
      return 'This vehicle already has an open assignment.';
    case 'DRIVER_NOT_FOUND':
      return 'Driver not found or not active.';
    case 'VEHICLE_NOT_FOUND':
      return 'Vehicle not found.';
    case 'ALREADY_ENDED':
      return 'This assignment has already ended.';
    case 'DOCUMENTS_INVALID':
      return 'Documents are missing, rejected, or expired. Request uploads before reactivating.';
    case 'VEHICLE_OWNERSHIP_MISMATCH':
      return 'That vehicle does not belong to this driver.';
    case 'NOT_VEHICLE_SCOPED':
      return 'This document is not vehicle-scoped.';
    case 'NOT_FOUND':
      return 'Record not found.';
    case 'REASON_REQUIRED':
      return 'A reason is required for this action.';
    case 'NO_DRIVER':
      return 'This vehicle is not assigned to a driver.';
    case 'ARCHIVED':
      return 'This vehicle is archived and cannot be changed that way.';
    case 'NOT_APPROVED':
      return 'Only an approved vehicle can be set Active.';
    case 'SUSPENDED':
      return 'Reactivate the vehicle before setting it Active.';
    case 'ACTIVE_IN_USE':
      return 'Choose another Active vehicle first, then archive this one.';
    case 'IS_PRIMARY':
      return 'Clear Primary on another saved vehicle before archiving this one.';
    case 'OPEN_ASSIGNMENT':
      return 'Return the open shared assignment to the fleet first.';
    default:
      return 'Could not complete that vehicle action.';
  }
}

export async function adminAssignSharedVehicle(input: {
  vehicleId: string;
  driverId: string;
  suspendPrevious?: boolean;
  reason?: string;
}) {
  const reason = (input.reason ?? '').trim();
  if (!reason) {
    return { ok: false as const, code: 'REASON_REQUIRED', message: adminVehicleLifecycleMessage('REASON_REQUIRED') };
  }
  return callRpc('admin_assign_shared_vehicle', {
    p_vehicle_id: input.vehicleId,
    p_driver_id: input.driverId,
    p_suspend_previous: input.suspendPrevious ?? true,
    p_reason: reason,
  });
}

export async function adminReturnSharedVehicleAssignment(assignmentId: string, reason?: string) {
  const ended = (reason ?? '').trim() || 'returned_to_fleet';
  return callRpc('admin_return_shared_vehicle_assignment', {
    p_assignment_id: assignmentId,
    p_ended_reason: ended,
  });
}

export async function adminReactivateDriverVehicle(input: {
  vehicleId: string;
  releaseTemporaryVehicleId?: string | null;
}) {
  return callRpc('admin_reactivate_driver_vehicle', {
    p_vehicle_id: input.vehicleId,
    p_release_temporary_vehicle_id: input.releaseTemporaryVehicleId ?? null,
  });
}

export async function adminSetTripActiveVehicle(vehicleId: string, reason: string) {
  const trimmed = reason.trim();
  if (!trimmed) {
    return { ok: false as const, code: 'REASON_REQUIRED', message: adminVehicleLifecycleMessage('REASON_REQUIRED') };
  }
  return callRpc('admin_set_trip_active_vehicle', {
    p_vehicle_id: vehicleId,
    p_reason: trimmed,
  });
}

export async function adminSuspendDriverVehicle(vehicleId: string, reason: string) {
  const trimmed = reason.trim();
  if (!trimmed) {
    return { ok: false as const, code: 'REASON_REQUIRED', message: adminVehicleLifecycleMessage('REASON_REQUIRED') };
  }
  return callRpc('admin_suspend_driver_vehicle', {
    p_vehicle_id: vehicleId,
    p_reason: trimmed,
  });
}

export async function adminArchiveDriverVehicle(vehicleId: string, reason: string) {
  const trimmed = reason.trim();
  if (!trimmed) {
    return { ok: false as const, code: 'REASON_REQUIRED', message: adminVehicleLifecycleMessage('REASON_REQUIRED') };
  }
  return callRpc('admin_archive_driver_vehicle', {
    p_vehicle_id: vehicleId,
    p_reason: trimmed,
  });
}

export async function adminResolveDocumentVehicleLink(documentId: string, vehicleId: string) {
  return callRpc('admin_resolve_document_vehicle_link', {
    p_document_id: documentId,
    p_vehicle_id: vehicleId,
  });
}

export async function adminRetireDocument(documentId: string, reason: string) {
  const trimmed = reason.trim();
  if (!trimmed) {
    return { ok: false as const, code: 'REASON_REQUIRED', message: adminVehicleLifecycleMessage('REASON_REQUIRED') };
  }
  return callRpc('admin_retire_document', {
    p_document_id: documentId,
    p_reason: trimmed,
  });
}

export type OpenVehicleAssignment = {
  id: string;
  vehicle_id: string;
  driver_id: string;
  assignment_kind: string;
  started_at: string;
  licence_plate: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
  driver_first_name: string | null;
  driver_last_name: string | null;
};

export async function adminListOpenVehicleAssignments(
  driverId?: string | null,
): Promise<OpenVehicleAssignment[]> {
  const { data, error } = await supabase.rpc('admin_list_open_vehicle_assignments' as never, {
    p_driver_id: driverId ?? null,
  } as never);
  if (error) return [];
  const root = (data ?? {}) as { ok?: boolean; assignments?: unknown };
  if (root.ok !== true || !Array.isArray(root.assignments)) return [];
  return root.assignments as OpenVehicleAssignment[];
}

export type VehicleChangeRequestRow = {
  id: string;
  driver_id: string;
  vehicle_id: string;
  requested_make: string;
  requested_model: string;
  requested_year: number;
  requested_color: string;
  requested_license_plate: string;
  status: string;
  admin_notes: string | null;
  rejection_reason: string | null;
  created_at: string;
  reviewed_at: string | null;
  cancelled_at: string | null;
  driver?: {
    first_name: string;
    last_name: string;
    driver_code: string | null;
  } | null;
  vehicle?: {
    make: string;
    model: string;
    year: number;
    color: string;
    license_plate: string;
  } | null;
};

/** Page-RBAC list of vehicle change requests (Vehicles / Drivers page access). */
export async function adminListVehicleChangeRequests(
  limit = 200,
): Promise<VehicleChangeRequestRow[]> {
  const { data, error } = await supabase.rpc('admin_list_vehicle_change_requests' as never, {
    p_limit: limit,
  } as never);
  if (error) throw error;
  const root = (data ?? {}) as { ok?: boolean; requests?: unknown };
  if (root.ok !== true || !Array.isArray(root.requests)) return [];
  return root.requests as VehicleChangeRequestRow[];
}

export type VehicleDocComplianceSummary = {
  vehicle_id: string;
  rules_available: boolean;
  summary:
    | 'complete'
    | 'pending_review'
    | 'action_needed'
    | 'expired'
    | 'missing'
    | 'none_required'
    | 'n_a'
    | 'rules_unavailable'
    | string;
  label: string;
  required_count: number;
  missing: number;
  pending: number;
  rejected: number;
  expired: number;
  approved: number;
};

/**
 * Per-vehicle SA ∩ vehicle-scoped document compliance.
 * Only documents with vehicle_id = that vehicle; never driver-level or other vehicles.
 */
export async function adminVehicleDocumentComplianceSummaries(
  vehicleIds: string[],
): Promise<Map<string, VehicleDocComplianceSummary>> {
  const unique = Array.from(new Set(vehicleIds.filter(Boolean)));
  const map = new Map<string, VehicleDocComplianceSummary>();
  if (unique.length === 0) return map;

  const { data, error } = await supabase.rpc(
    'admin_vehicle_document_compliance_summaries' as never,
    { p_vehicle_ids: unique } as never,
  );
  if (error) throw error;
  const root = (data ?? {}) as { ok?: boolean; summaries?: unknown };
  if (root.ok !== true || !Array.isArray(root.summaries)) return map;
  for (const row of root.summaries as VehicleDocComplianceSummary[]) {
    if (row?.vehicle_id) map.set(row.vehicle_id, row);
  }
  return map;
}
