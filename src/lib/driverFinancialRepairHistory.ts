/**
 * Read-only Review & repair history mappers (Finance SELECT only — no mutations).
 */

export type DriverFinancialRepairRequestRow = {
  id: string;
  repair_token: string;
  driver_id: string;
  trip_id: string;
  preview_hash: string;
  classification: string;
  status: string;
  apply_reason: string | null;
  apply_result: Record<string, unknown> | null;
  created_by_admin_id: string;
  applied_by_admin_id: string | null;
  created_at: string;
  applied_at: string | null;
  trips?: { trip_code?: string | null } | null;
};

export type DriverFinancialRepairAuditRow = {
  id: string;
  event_type: string;
  repair_token: string;
  preview_hash: string | null;
  driver_id: string | null;
  trip_id: string | null;
  admin_user_id: string;
  reason: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
};

export type StaffNameByUserId = Record<string, string>;

export type DriverFinancialRepairHistoryDisplayRow = {
  id: string;
  repair_token: string;
  created_at: string;
  applied_at: string | null;
  trip_code: string | null;
  trip_id: string;
  classification: string;
  status: string;
  admin_actor: string;
  reason: string | null;
  preview_hash: string;
  wallet_delta_pence: number | null;
  audit_sequence: string[];
  failure_or_block_reason: string | null;
};

function asNullableInt(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? n : null;
}

export function resolveRepairAdminActorLabel(args: {
  created_by_admin_id: string;
  applied_by_admin_id?: string | null;
  staffByUserId?: StaffNameByUserId | null;
}): string {
  const preferred = args.applied_by_admin_id || args.created_by_admin_id;
  const name = args.staffByUserId?.[preferred];
  if (name?.trim()) return name.trim();
  return preferred ? `${preferred.slice(0, 8)}…` : '—';
}

export function extractRepairWalletDeltaPence(
  applyResult: Record<string, unknown> | null | undefined,
): number | null {
  if (!applyResult || typeof applyResult !== 'object') return null;
  if ('actual_wallet_delta_pence' in applyResult) {
    return asNullableInt(applyResult.actual_wallet_delta_pence);
  }
  if ('proven_wallet_delta_pence' in applyResult) {
    return asNullableInt(applyResult.proven_wallet_delta_pence);
  }
  return null;
}

export function extractRepairFailureOrBlockReason(args: {
  status: string;
  apply_result?: Record<string, unknown> | null;
  audits?: DriverFinancialRepairAuditRow[] | null;
}): string | null {
  const blocked = (args.audits ?? [])
    .filter((a) => a.event_type === 'FINANCIAL_REPAIR_BLOCKED')
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  const lastBlock = blocked[blocked.length - 1];
  if (lastBlock) {
    const details = lastBlock.details ?? {};
    const code = details.error_code != null ? String(details.error_code) : null;
    const reason = lastBlock.reason?.trim() || (details.block_reason != null ? String(details.block_reason) : null);
    if (code && reason) return `${code}: ${reason}`;
    return code || reason || 'Blocked';
  }
  if (String(args.status).toUpperCase() === 'BLOCKED') {
    const result = args.apply_result ?? {};
    const code = result.error_code != null ? String(result.error_code) : null;
    const reason = result.error != null ? String(result.error) : null;
    if (code && reason) return `${code}: ${reason}`;
    return code || reason || 'Blocked';
  }
  return null;
}

export function buildRepairAuditSequence(
  audits: DriverFinancialRepairAuditRow[] | null | undefined,
  repairToken: string,
): string[] {
  return (audits ?? [])
    .filter((a) => a.repair_token === repairToken)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    .map((a) => a.event_type);
}

/** Pure mapper — never mutates; safe for unit tests. */
export function mapDriverFinancialRepairHistoryRows(args: {
  requests: DriverFinancialRepairRequestRow[];
  audits?: DriverFinancialRepairAuditRow[] | null;
  staffByUserId?: StaffNameByUserId | null;
}): DriverFinancialRepairHistoryDisplayRow[] {
  return [...args.requests]
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map((req) => ({
      id: req.id,
      repair_token: req.repair_token,
      created_at: req.created_at,
      applied_at: req.applied_at,
      trip_code: req.trips?.trip_code ?? null,
      trip_id: req.trip_id,
      classification: req.classification,
      status: req.status,
      admin_actor: resolveRepairAdminActorLabel({
        created_by_admin_id: req.created_by_admin_id,
        applied_by_admin_id: req.applied_by_admin_id,
        staffByUserId: args.staffByUserId,
      }),
      reason: req.apply_reason,
      preview_hash: req.preview_hash,
      wallet_delta_pence: extractRepairWalletDeltaPence(req.apply_result),
      audit_sequence: buildRepairAuditSequence(args.audits, req.repair_token),
      failure_or_block_reason: extractRepairFailureOrBlockReason({
        status: req.status,
        apply_result: req.apply_result,
        audits: (args.audits ?? []).filter((a) => a.repair_token === req.repair_token),
      }),
    }));
}

/** History UI is read-only — no insert/update/delete helpers. */
export function driverFinancialRepairHistoryIsReadOnly(): true {
  return true;
}
