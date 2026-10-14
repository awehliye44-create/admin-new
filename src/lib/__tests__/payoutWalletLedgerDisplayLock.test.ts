import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  driverCreditStatusLabel,
  unbackedWalletReasonLabel,
} from '@/lib/driverWalletPayoutStatusDisplay';

const read = (rel: string) => readFileSync(resolve(__dirname, '../../..', rel), 'utf8');

describe('Credit status chip', () => {
  it('labels an empty period without turning UNKNOWN into OK', () => {
    expect(driverCreditStatusLabel('DRIVER_CREDIT_UNKNOWN', 'NO_TRIPS_IN_PERIOD')).toBe('No trips in period');
    expect(driverCreditStatusLabel('DRIVER_CREDIT_UNKNOWN', 'NO_TRIPS_IN_PERIOD')).not.toMatch(/OK/);
  });

  it('keeps genuine UNKNOWN reasons visible', () => {
    expect(driverCreditStatusLabel('DRIVER_CREDIT_UNKNOWN', 'WALLET_EVIDENCE_UNAVAILABLE')).toMatch(/^Credit unknown/);
    expect(driverCreditStatusLabel('DRIVER_CREDIT_UNKNOWN', null)).toBe('DRIVER_CREDIT_UNKNOWN');
    expect(driverCreditStatusLabel('DRIVER_UNDER_CREDITED', 'NO_TRIPS_IN_PERIOD')).toBe('DRIVER_UNDER_CREDITED');
  });

  it('names unrecorded cash-out fees as such, never as earnings', () => {
    expect(unbackedWalletReasonLabel('CASHOUT_FEE_NOT_RECORDED')).toBe('Cash-out fee not recorded');
    expect(unbackedWalletReasonLabel('UNBACKED_WALLET_BALANCE')).toMatch(/review/i);
  });
});

describe('Payout Ledger driver payouts columns', () => {
  const page = read('src/pages/PayoutLedger.tsx');

  it('shows Reserved and Held / Unbacked so Live is fully explained', () => {
    expect(page).toContain('<TableHead title="Active payout reservations and in-flight cash-outs">Reserved</TableHead>');
    expect(page).toContain('Held / Unbacked');
    expect(page).not.toContain('<TableHead>Pending/Held</TableHead>');
  });

  it('never prints a calendar slot for a driver the next run will not pay', () => {
    expect(page).toContain('row.next_scheduled_note');
    expect(page).not.toContain("<TableCell className=\"text-xs\">{row.next_scheduled_local ?? '—'}</TableCell>");
  });

  it('bank account status comes from the real destination', () => {
    expect(page).not.toContain("account?.verification === 'manual_bank'");
    expect(page).toContain("account?.verification === 'verified'");
  });
});

describe('Driver Wallet Ledger active list', () => {
  const list = read('src/components/finance/DriverWalletDriverList.tsx');

  it('labels the period-scoped column and shows live + unbacked', () => {
    expect(list).toContain('Credit variance (period)');
    expect(list).not.toContain('>Open difference<');
    expect(list).toContain('Live wallet');
    expect(list).toContain('unbacked_wallet_pence');
  });

  it('passes the UNKNOWN reason to Review & repair visibility', () => {
    expect(list).toContain('driver_credit_unknown_reason: row.driver_credit_unknown_reason');
  });
});
