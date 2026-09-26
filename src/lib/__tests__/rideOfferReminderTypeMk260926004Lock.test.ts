/**
 * LOCK MK-260926-004: ride-offer-reminders must use envelope type RIDE_OFFER.
 * RIDE_OFFER_REMINDER is rejected by send-driver-notification allow-list →
 * send_failed and silent iOS continuous re-alert failure.
 * Parity with ios-offer-realert. If this fails, fix the code — never soften.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('rideOfferReminderTypeMk260926004Lock', () => {
  it('reminders send type RIDE_OFFER with is_reminder — never RIDE_OFFER_REMINDER', () => {
    const src = read('supabase/functions/ride-offer-reminders/index.ts');
    expect(src).toContain('type: "RIDE_OFFER"');
    expect(src).toContain('is_reminder: "true"');
    // Envelope type only — comments may mention the rejected token historically.
    expect(src).not.toMatch(/type:\s*["']RIDE_OFFER_REMINDER["']/);
  });

  it('send-driver-notification allow-list includes RIDE_OFFER and excludes RIDE_OFFER_REMINDER', () => {
    const src = read('supabase/functions/send-driver-notification/index.ts');
    expect(src).toMatch(/VALID_NOTIFICATION_TYPES\s*=\s*\[[\s\S]*?'RIDE_OFFER'/);
    expect(src).not.toContain("'RIDE_OFFER_REMINDER'");
    expect(src).not.toContain('"RIDE_OFFER_REMINDER"');
  });

  it('ios-offer-realert stays on RIDE_OFFER + ios_realert', () => {
    const src = read('supabase/functions/ios-offer-realert/index.ts');
    expect(src).toContain('type: "RIDE_OFFER"');
    expect(src).toContain('ios_realert: "true"');
    expect(src).not.toContain('RIDE_OFFER_REMINDER');
  });
});
