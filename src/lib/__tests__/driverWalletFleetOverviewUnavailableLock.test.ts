/**
 * #71B — Failed Edge loads must not render as £0 / 0 drivers.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

describe('driver wallet fleet unavailable display lock', () => {
  it('fleet overview does not default failed data to empty array zeros', () => {
    const src = read('src/components/finance/DriverWalletFleetOverviewCards.tsx');
    expect(src).not.toMatch(/data:\s*drivers\s*=\s*\[\]/);
    expect(src).toContain("balances unavailable (not £0)");
    expect(src).toContain('showUnavailable');
    expect(src).toContain('Retry');
  });

  it('active driver list distinguishes unavailable from empty fleet', () => {
    const src = read('src/components/finance/DriverWalletDriverList.tsx');
    expect(src).toContain('showUnavailableEmpty');
    expect(src).toContain('not an empty fleet');
    expect(src).toContain('Wallet data unavailable');
  });

  it('fleet all-pages query keeps previous data on failure', () => {
    const src = read('src/hooks/useDriverWalletSsot.ts');
    expect(src).toContain('useDriverWalletSsotAll');
    expect(src).toMatch(/placeholderData:\s*keepPreviousData/);
  });
});
