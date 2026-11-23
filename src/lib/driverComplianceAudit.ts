export type ComplianceAuditEntityFilter = 'all' | 'document' | 'vehicle';

type BadgeTone = 'default' | 'secondary' | 'destructive' | 'outline';

const ACTIONS: Record<string, { label: string; tone: BadgeTone }> = {
  uploaded: { label: 'Uploaded', tone: 'secondary' },
  added: { label: 'Added', tone: 'secondary' },
  approved: { label: 'Approved', tone: 'default' },
  rejected: { label: 'Rejected', tone: 'destructive' },
  re_rejected: { label: 'Re-rejected', tone: 'destructive' },
  set_pending: { label: 'Set pending', tone: 'outline' },
  expired: { label: 'Expired', tone: 'destructive' },
  superseded: { label: 'Replaced by newer upload', tone: 'outline' },
  expiry_changed: { label: 'Expiry date changed', tone: 'outline' },
  updated: { label: 'Edited', tone: 'outline' },
  status_changed: { label: 'Status changed', tone: 'outline' },
  unassigned: { label: 'Unassigned from driver', tone: 'outline' },
  deleted: { label: 'Deleted', tone: 'destructive' },
  change_requested: { label: 'Change requested', tone: 'secondary' },
  change_approved: { label: 'Change approved', tone: 'default' },
  change_rejected: { label: 'Change rejected', tone: 'destructive' },
  change_cancelled: { label: 'Change cancelled', tone: 'outline' },
  change_updated: { label: 'Change request edited', tone: 'outline' },
  restored: { label: 'Restored', tone: 'outline' },
};

export function describeAuditAction(action: string): { label: string; tone: BadgeTone } {
  return ACTIONS[action] ?? { label: action.replace(/_/g, ' '), tone: 'outline' };
}

const FIELD_LABELS: Record<string, string> = {
  status: 'Status',
  approval_status: 'Status',
  expiry_date: 'Expiry date',
  rejection_reason: 'Rejection reason',
  notes: 'Notes',
  admin_notes: 'Admin notes',
  document_type: 'Document type',
  document_name: 'Document name',
  is_current: 'Current version',
  file: 'File',
  make: 'Make',
  model: 'Model',
  year: 'Year',
  color: 'Colour',
  license_plate: 'Licence plate',
  is_primary: 'Primary vehicle',
  capacity: 'Seats',
  vehicle_type_id: 'Vehicle type',
  driver_id: 'Assigned driver',
};

export function labelAuditField(field: string): string {
  return FIELD_LABELS[field] ?? field.replace(/_/g, ' ');
}

export function formatAuditChangeValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (field === 'expiry_date' && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) {
    const [y, m, d] = value.slice(0, 10).split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
    });
  }
  if ((field === 'vehicle_type_id' || field === 'driver_id') && typeof value === 'string') {
    return value.slice(0, 8);
  }
  return String(value);
}

export interface AuditActorFields {
  actor_kind: string;
  actor_name: string | null;
  actor_username: string | null;
  actor_user_id: string | null;
  source: string;
}

const KIND_LABELS: Record<string, string> = {
  staff: 'Staff',
  admin: 'Admin',
  driver: 'Driver',
  user: 'User',
};

/** "ONECAB Administrator (@admin) · Staff", "Mohamed Handule · Driver", "System". */
export function describeAuditActor(row: AuditActorFields): string {
  if (!row.actor_user_id) {
    return row.source === 'backfill' ? 'Not recorded' : 'System';
  }
  const name = row.actor_name || 'Unknown';
  const username = row.actor_username ? ` (@${row.actor_username})` : '';
  const kind = KIND_LABELS[row.actor_kind];
  return `${name}${username}${kind ? ` · ${kind}` : ''}`;
}
