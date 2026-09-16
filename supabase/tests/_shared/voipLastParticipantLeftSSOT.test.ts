import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { shouldFinalizeVoipOnLastParticipantLeft } from './voipLastParticipantLeftSSOT.ts';

Deno.test('solo ringing/connecting leave must not finalize (self hang-up lock)', () => {
  assertEquals(
    shouldFinalizeVoipOnLastParticipantLeft({ status: 'ringing', connected_at: null }),
    false,
  );
  assertEquals(
    shouldFinalizeVoipOnLastParticipantLeft({ status: 'connecting', connected_at: null }),
    false,
  );
  assertEquals(
    shouldFinalizeVoipOnLastParticipantLeft({ status: 'requested', connected_at: null }),
    false,
  );
});

Deno.test('connected/active last leave may finalize', () => {
  assertEquals(
    shouldFinalizeVoipOnLastParticipantLeft({
      status: 'active',
      connected_at: '2026-08-15T18:00:00.000Z',
    }),
    true,
  );
  assertEquals(
    shouldFinalizeVoipOnLastParticipantLeft({
      status: 'connecting',
      connected_at: '2026-08-15T18:00:00.000Z',
    }),
    true,
  );
});

Deno.test('solo ring room_finished must not finalize', () => {
  assertEquals(
    shouldFinalizeVoipOnLastParticipantLeft({ status: 'ringing', connected_at: null }),
    false,
  );
});
