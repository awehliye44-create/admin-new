import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(__dirname, '../..');

function read(rel: string): string {
  return readFileSync(resolve(ROOT, rel), 'utf8');
}

describe('admin trip operational payment ownership lock', () => {
  it('Trip History uses Payment Sessions disposition and not wallet/payout capture SSOT', () => {
    const src = read('pages/TripHistory.tsx');
    expect(src).toContain('loadPaymentSessionsByTripIds');
    expect(src).toContain('payment_disposition');
    expect(src).not.toContain('fetchTripsCaptureSsot');
    expect(src).not.toContain('driver_wallet_ledger');
    expect(src).not.toContain('payout_items');
    expect(src).not.toContain('ledger_trip_earning_net_pence');
  });

  it('Missed & Cancelled uses disposition and excludes no-show routing', () => {
    const src = read('pages/MissedCancelled.tsx');
    expect(src).toContain('enrichTripsWithPaymentDisposition');
    expect(src).toContain('belongsInMissedCancelled');
    expect(src).not.toContain('Lost Fare');
    expect(src).not.toContain('Lost Revenue');
    expect(src).toContain('Quoted fare impact');
    expect(src).not.toContain('driver_wallet_ledger');
    expect(src).not.toContain('payout_items');
  });
});
