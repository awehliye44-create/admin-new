/**
 * Lock: Admin Add Documents status colours match Driver My Documents badges.
 */
import { describe, expect, it } from 'vitest';
import { adminChecklistStatusTone } from '@/lib/adminDriverDocumentChecklist';

describe('adminDocumentStatusToneLock', () => {
  it('keeps Driver DocumentStatusBadge token colours', () => {
    // Driver theme tokens: statusCompleted*, statusNoShow*, statusCancelled*, mapFallback
    expect(adminChecklistStatusTone('approved').backgroundColor).toBe('#E8F6EC');
    expect(adminChecklistStatusTone('approved').color).toBe('#2F7D46');
    expect(adminChecklistStatusTone('expiring_soon').backgroundColor).toBe('#FBF0D6');
    expect(adminChecklistStatusTone('expired').color).toBe('#C0392B');
    expect(adminChecklistStatusTone('rejected').backgroundColor).toBe('#F8E4E3');
    expect(adminChecklistStatusTone('missing').backgroundColor).toBe('#E8EEF7');
    expect(adminChecklistStatusTone('not_uploaded').backgroundColor).toBe('#F2F2F0');
  });
});
