/**
 * Lock: killed-state iOS NRO sound + Android channel must stay WAV / v3 end-to-end.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = path.join(__dirname, '../../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

describe('rideOfferKilledStateSoundLock', () => {
  it('Edge push SSOT uses onecab_new_ride_offer.wav and v3 channel — never CAF', () => {
    const copy = read('supabase/functions/_shared/rideOfferPushCopy.ts');
    expect(copy).toContain(
      "export const RIDE_OFFER_IOS_ALERT_SOUND = 'onecab_new_ride_offer.wav'",
    );
    expect(copy).toContain(
      "export const RIDE_OFFER_ANDROID_CHANNEL_ID = 'onecab_new_ride_offers_v3'",
    );
    expect(copy).not.toContain('ride_offer_alert.caf');
    // Canonical constant must be the live WAV (historical wrong filename may appear in comments only).
    expect(copy).toMatch(
      /RIDE_OFFER_IOS_ALERT_SOUND\s*=\s*'onecab_new_ride_offer\.wav'/,
    );
    expect(copy).not.toMatch(
      /RIDE_OFFER_IOS_ALERT_SOUND\s*=\s*'onecab_true_original_refined\.wav'/,
    );

    for (const rel of [
      'supabase/functions/send-driver-notification/index.ts',
      'supabase/functions/auto-dispatch/index.ts',
      'supabase/functions/ride-offer-reminders/index.ts',
    ]) {
      const src = read(rel);
      expect(src).toContain('RIDE_OFFER_IOS_ALERT_SOUND');
      expect(src).not.toContain('ride_offer_alert.caf');
    }
  });
});
