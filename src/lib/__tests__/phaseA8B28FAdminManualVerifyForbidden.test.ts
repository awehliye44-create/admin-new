/**
 * A8B28F Stage B3 — Admin manual verify forbidden (source-lock + writer scan).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '../../..');
const LIVE = resolve(
  ROOT,
  'supabase/functions/admin-verify-driver-payout-destination/index.ts',
);

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.git' || name === 'drafts') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkFiles(p, out);
    else if (/\.(ts|tsx|sql)$/.test(name)) out.push(p);
  }
  return out;
}

describe('phase A8B28F Stage B3 admin verify prohibition', () => {
  const live = readFileSync(LIVE, 'utf8');

  it('live forbids verify with 403 and never writes MANUAL_VERIFIED status', () => {
    expect(live).toMatch(/ADMIN_MANUAL_VERIFY_FORBIDDEN/);
    expect(live).toMatch(/status: 403/);
    expect(live).toMatch(/action === "verify"/);
    expect(live).not.toMatch(/DESTINATION_STATUS\.MANUAL_VERIFIED/);
    expect(live).not.toMatch(/verification_status:\s*["']MANUAL_VERIFIED["']/);
    expect(live).toMatch(/assert_finance_payout_ledger_access/);
    expect(live).not.toMatch(/from\("profiles"\)/);
    expect(live).not.toMatch(/\buser_metadata\b/);
    expect(live).not.toMatch(/raw_user_meta_data/);
    expect(live).not.toMatch(/from\("user_roles"\)/);
  });

  it('verify forbid precedes service-role mutation client', () => {
    const verifyIdx = live.indexOf('action === "verify"');
    const serviceIdx = live.lastIndexOf('SUPABASE_SERVICE_ROLE_KEY');
    expect(verifyIdx).toBeGreaterThan(0);
    expect(serviceIdx).toBeGreaterThan(verifyIdx);
  });

  it('repo scan: no Edge/SQL assignment writer of MANUAL_VERIFIED remains outside SSOT enum', () => {
    const files = [
      ...walkFiles(join(ROOT, 'supabase/functions')),
      ...walkFiles(join(ROOT, 'supabase/migrations')),
      ...walkFiles(join(ROOT, 'src')),
    ];
    const writers: string[] = [];
    const assignRe =
      /(?:verification_status\s*[:=]\s*['"]MANUAL_VERIFIED['"]|DESTINATION_STATUS\.MANUAL_VERIFIED\s*[,;)]|statusForAction\([\s\S]*MANUAL_VERIFIED)/;
    for (const f of files) {
      if (f.includes('adminVerifyPayoutDestination.b3Lock.test.ts')) continue;
      if (f.includes('phaseA8B28FAdminManualVerifyForbidden.test.ts')) continue;
      if (f.includes('driverPayoutDestinationSSOT.ts')) continue; // enum/normalize only
      if (f.includes('DriverPayoutPanel')) continue; // UI label, not DB writer
      if (f.includes('__tests__')) continue;
      if (f.includes('drafts')) continue;
      const text = readFileSync(f, 'utf8');
      if (!text.includes('MANUAL_VERIFIED')) continue;
      // Skip pure exclusion / comment / read checks
      if (
        /IS DISTINCT FROM 'MANUAL_VERIFIED'|!== ['"]MANUAL_VERIFIED['"]|=== ['"]MANUAL_VERIFIED['"]|IN \([^)]*MANUAL_VERIFIED/.test(
          text,
        ) &&
        !assignRe.test(text) &&
        !/verification_status:\s*DESTINATION_STATUS\.MANUAL_VERIFIED/.test(text)
      ) {
        continue;
      }
      if (assignRe.test(text) || /return DESTINATION_STATUS\.MANUAL_VERIFIED/.test(text)) {
        writers.push(f.replace(ROOT + '/', ''));
      }
    }
    expect(writers).toEqual([]);
  });
});
