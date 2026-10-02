/**
 * Pure gate: LiveKit participant_left must not self-end a solo ringing caller.
 *
 * Driver/customer Call in app connects alone while the peer rings. Audio
 * reassert / brief ICE blips fire participant_left with remaining=0. Finalising
 * that as missed deletes the room → client onDisconnected → hangUp (self hang-up).
 */

export function shouldFinalizeVoipOnLastParticipantLeft(log: {
  connected_at?: string | null;
  status?: string | null;
}): boolean {
  const status = String(log.status ?? '')
    .trim()
    .toLowerCase();
  const hadBothParties = Boolean(log.connected_at) || status === 'active';
  if (hadBothParties) return true;

  // Solo outbound/inbound ring or first-leg connecting — leave room open for
  // reconnect; client hang-up / timeout sweep own abandoned ringing sessions.
  if (
    status === 'requested' ||
    status === 'ringing' ||
    status === 'connecting' ||
    status === ''
  ) {
    return false;
  }

  return false;
}
