/**
 * Lock: public storage buckets stay downloadable, but not listable.
 * If this fails, fix the draft — never delete or soften the lock.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');
const CANONICAL = 'supabase/migrations/20261107223000_storage_public_bucket_listing_lock.sql';
const ROLLBACK = 'supabase/migrations/rollback/rollback_20261107223000_storage_public_bucket_listing_lock.sql';

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('storagePublicBucketListingLock', () => {
  it('drops only the two listing policies and does not privatize buckets', () => {
    const sql = read(CANONICAL);
    const rb = read(ROLLBACK);
    const outbound = read('supabase/functions/_shared/whatsappOutbound.ts');
    const resolver = read('supabase/functions/_shared/alertSoundResolver.ts');
    const admin = read('src/hooks/useAlertSounds.ts');

    expect(sql).toMatch(/DROP POLICY "Anyone can read alert sounds" ON storage\.objects/i);
    expect(sql).toMatch(/DROP POLICY "Public read WhatsApp welcome assets" ON storage\.objects/i);
    expect(sql).not.toMatch(/UPDATE\s+storage\.buckets/i);
    expect(sql).not.toMatch(/public\s*=\s*false/i);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+storage\.objects/i);
    expect(sql).not.toMatch(/DELETE\s+FROM\s+storage\.objects/i);
    expect(sql).not.toMatch(/Admins can upload alert sounds/i);
    expect(sql).not.toMatch(/Admins can update alert sounds/i);
    expect(sql).not.toMatch(/Admins can delete alert sounds/i);

    expect(rb).toMatch(/CREATE POLICY "Anyone can read alert sounds"/i);
    expect(rb).toMatch(/TO anon, authenticated/i);
    expect(rb).toMatch(/USING \(bucket_id = 'alert-sounds'\)/i);
    expect(rb).toMatch(/CREATE POLICY "Public read WhatsApp welcome assets"/i);
    expect(rb).toMatch(/TO public/i);
    expect(rb).toMatch(/USING \(bucket_id = 'whatsapp-public'\)/i);
    expect(rb).not.toMatch(/\bDROP POLICY\b/i);

    expect(outbound).toContain('/storage/v1/object/public/whatsapp-public/welcome-header.jpg');
    expect(resolver).toContain('/storage/v1/object/public/${BUCKET}/${path}');
    expect(admin).toContain(".from('alert_sounds')");
    expect(admin).toContain(".getPublicUrl(storagePath)");
    expect(admin).not.toContain('.list(');
  });
});
