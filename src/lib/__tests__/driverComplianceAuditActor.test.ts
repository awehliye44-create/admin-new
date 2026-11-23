import { describe, expect, it } from 'vitest';
import { describeAuditActor } from '@/lib/driverComplianceAudit';

describe('describeAuditActor', () => {
  it('shows the staff username next to the staff name', () => {
    expect(describeAuditActor({
      actor_kind: 'staff', actor_name: 'ONECAB Administrator', actor_username: 'admin',
      actor_user_id: '9ab3080c-73ef-4c36-b92b-ae8e8f4815f2', source: 'live',
    })).toBe('ONECAB Administrator (@admin) · Staff');
  });

  it('never invents a reviewer for earlier records that did not save one', () => {
    expect(describeAuditActor({
      actor_kind: 'system', actor_name: 'System', actor_username: null, actor_user_id: null, source: 'backfill',
    })).toBe('Not recorded');
  });
});
