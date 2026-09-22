/**
 * LOCK — Driver found-report + Customer create_case must land in lost_property_cases.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '../../..');

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('lost property create wiring lock', () => {
  it('Edge lost-property accepts driver_create_found_report + driver_attach_found_photos', () => {
    const edge = readSrc('supabase/functions/lost-property/index.ts');
    expect(edge).toContain('case "driver_create_found_report"');
    expect(edge).toContain('case "driver_attach_found_photos"');
    expect(edge).toContain('async function driverCreateFoundReport');
    expect(edge).toContain('async function driverAttachFoundPhotos');
    expect(edge).toContain('case_origin: "driver_found"');
    expect(edge).toContain('status: "OPEN"');
  });

  it('create_case sets case_origin customer_lost for Admin list', () => {
    const edge = readSrc('supabase/functions/lost-property/index.ts');
    expect(edge).toContain('case_origin: "customer_lost"');
    expect(edge).toContain('case "create_case"');
  });

  it('status migration allows OPEN and CANCELLED', () => {
    const mig = readSrc(
      'supabase/migrations/20261122170000_lost_property_driver_found_status_lock.sql',
    );
    expect(mig).toContain("'OPEN'");
    expect(mig).toContain("'CANCELLED'");
    expect(mig).toContain('driver_cancelled');
  });

  it('Admin list selects case_origin / item_name and labels OPEN', () => {
    const hook = readSrc('src/hooks/useLostProperty.ts');
    expect(hook).toContain('case_origin');
    expect(hook).toContain('item_name');
    expect(hook).toContain('OPEN: \'Open (Driver found)\'');
    expect(hook).toContain('CANCELLED:');
  });
});
