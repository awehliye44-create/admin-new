/**
 * Visibility + cancel-no-mutation locks for Pause/Resume on Driver Wallet + Payout Ledger.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  promptAndSetDriverOperationalPause,
  resolveDriverOperationalPauseMenuAction,
} from '../driverOperationalPauseMenu';

const ROOT = resolve(__dirname, '../../..');
const RESOLVER = resolve(ROOT, 'src/lib/driverOperationalPauseMenu.ts');
const MENU_ITEM = resolve(ROOT, 'src/components/finance/DriverOperationalPauseMenuItem.tsx');
const INLINE = resolve(ROOT, 'src/components/finance/DriverOperationalPauseInlineButton.tsx');
const WALLET_LIST = resolve(ROOT, 'src/components/finance/DriverWalletDriverList.tsx');
const WALLET_HEADER = resolve(ROOT, 'src/components/finance/DriverWalletAccountHeader.tsx');
const PAYOUT_LEDGER = resolve(ROOT, 'src/pages/PayoutLedger.tsx');
const CLIENT = resolve(ROOT, 'src/lib/adminSetDriverPayoutOperationalPause.ts');
const APP = resolve(ROOT, 'src/App.tsx');

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: vi.fn(async () => ({ data: { ok: true, payout_operational_paused: false, payouts_enabled: true, unchanged: false }, error: null })),
  },
}));

describe('driverOperationalPauseMenuVisibilityLock', () => {
  it('operational pause true → Resume visible', () => {
    const menu = resolveDriverOperationalPauseMenuAction({
      payout_operational_paused: true,
      payouts_enabled: false,
    });
    expect(menu.label).toBe('Resume payouts');
    expect(menu.action).toBe('resume');
    expect(menu.nextPaused).toBe(false);
    expect(menu.testId).toBe('driver-operational-pause-resume');
  });

  it('operational pause false → Pause visible', () => {
    const menu = resolveDriverOperationalPauseMenuAction({
      payout_operational_paused: false,
      payouts_enabled: true,
    });
    expect(menu.label).toBe('Pause payouts');
    expect(menu.action).toBe('pause');
    expect(menu.nextPaused).toBe(true);
  });

  it('legacy payouts_enabled cannot control the label', () => {
    const pausedLegacyOff = resolveDriverOperationalPauseMenuAction({
      payout_operational_paused: false,
      payouts_enabled: false,
    });
    expect(pausedLegacyOff.label).toBe('Pause payouts');

    const resumeDespiteLegacyOn = resolveDriverOperationalPauseMenuAction({
      payout_operational_paused: true,
      payouts_enabled: true,
    });
    expect(resumeDespiteLegacyOn.label).toBe('Resume payouts');

    // Ambiguous missing canonical + paused alias only
    const fromAlias = resolveDriverOperationalPauseMenuAction({
      paused: true,
      payouts_enabled: true,
    });
    expect(fromAlias.label).toBe('Resume payouts');
  });

  it('opening/cancelling confirm or reason creates no mutation', async () => {
    const rpc = vi.fn();
    const { supabase } = await import('@/integrations/supabase/client');
    (supabase.rpc as ReturnType<typeof vi.fn>).mockImplementation(rpc);

    const cancelConfirm = await promptAndSetDriverOperationalPause({
      driverId: '56136f5f-1a3a-4a14-bb23-439b3951415a',
      driverCode: 'MK0007',
      currentlyPaused: true,
      confirmFn: () => false,
      promptFn: () => 'should-not-run',
    });
    expect(cancelConfirm).toEqual({ outcome: 'cancelled' });
    expect(rpc).not.toHaveBeenCalled();

    const cancelPrompt = await promptAndSetDriverOperationalPause({
      driverId: '56136f5f-1a3a-4a14-bb23-439b3951415a',
      driverCode: 'MK0007',
      currentlyPaused: true,
      confirmFn: () => true,
      promptFn: () => null,
    });
    expect(cancelPrompt).toEqual({ outcome: 'cancelled' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('Driver Wallet and Payout Ledger use the same resolver + menu item', () => {
    const walletList = readFileSync(WALLET_LIST, 'utf8');
    const walletHeader = readFileSync(WALLET_HEADER, 'utf8');
    const ledger = readFileSync(PAYOUT_LEDGER, 'utf8');
    const menuItem = readFileSync(MENU_ITEM, 'utf8');
    const inline = readFileSync(INLINE, 'utf8');
    const resolver = readFileSync(RESOLVER, 'utf8');

    expect(walletList).toMatch(/DriverOperationalPauseMenuItem/);
    expect(walletList).toMatch(/payout_operational_paused/);
    expect(walletHeader).toMatch(/DriverOperationalPauseInlineButton/);
    expect(walletHeader).toMatch(/payout_operational_paused/);
    expect(ledger).toMatch(/DriverOperationalPauseMenuItem/);
    expect(ledger).toMatch(/resolveDriverOperationalPauseMenuAction|DriverOperationalPauseMenuItem/);
    expect(ledger).not.toMatch(/row\.paused \? 'Resume payouts'/);
    expect(menuItem).toMatch(/resolveDriverOperationalPauseMenuAction/);
    expect(inline).toMatch(/resolveDriverOperationalPauseMenuAction/);
    expect(resolver).toMatch(/payouts_enabled/);
    expect(resolver).toMatch(/void input\.payouts_enabled/);
  });

  it('deployed routes contain the action surfaces', () => {
    const app = readFileSync(APP, 'utf8');
    expect(app).toMatch(/path="driver-wallet-ledger"/);
    expect(app).toMatch(/path="payout-ledger"/);
    const client = readFileSync(CLIENT, 'utf8');
    expect(client).toMatch(/admin_set_driver_payout_operational_pause/);
    expect(client).not.toMatch(/\.from\(\s*['"]drivers['"]\s*\)[\s\S]{0,120}\.update\(/);
  });

  it('menu item accessible test ids + aria labels', () => {
    const menuItem = readFileSync(MENU_ITEM, 'utf8');
    const inline = readFileSync(INLINE, 'utf8');
    expect(menuItem).toMatch(/data-testid=\{menu\.testId\}/);
    expect(menuItem).toMatch(/aria-label=\{menu\.ariaLabel\}/);
    expect(inline).toMatch(/data-testid=\{menu\.testId\}/);
    expect(inline).toMatch(/aria-label=\{menu\.ariaLabel\}/);
  });
});
