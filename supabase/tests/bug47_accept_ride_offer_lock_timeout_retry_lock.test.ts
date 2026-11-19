/**
 * Bug #47 — accept_ride_offer wrapper must fail-fast on lock contention and retry.
 * Source lock: migration 20270227130000_accept_ride_offer_lock_timeout_retry.sql
 * + Edge accept-offer transient RPC retry.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const root = path.join(__dirname, '..');

function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

describe('Bug #47 accept_ride_offer lock_timeout retry lock', () => {
  it('migration sets lock_timeout and retries lock_not_available', () => {
    const mig = read(
      'migrations/20270227130000_accept_ride_offer_lock_timeout_retry.sql',
    );
    expect(mig).toContain("set_config('lock_timeout', '1500ms', true)");
    expect(mig).toContain('lock_not_available');
    expect(mig).toContain('v_max_attempts constant integer := 5');
    expect(mig).toContain('accept_ride_offer_contention_result');
    // Never change payment / Revolut paths in this migration.
    expect(mig).not.toMatch(/revolut|increment.?auth|google.?pay/i);
  });

  it('Edge accept-offer retries transient RPC errors and reconciles assignment', () => {
    const edge = read('functions/accept-offer/index.ts');
    expect(edge).toContain('isTransientAcceptRpcError');
    expect(edge).toContain('ACCEPT_RECONCILED_AFTER_RPC_ERROR');
    expect(edge).toContain('maxRpcAttempts');
    expect(edge).toContain('statement timeout');
  });
});
