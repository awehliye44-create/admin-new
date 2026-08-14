/** Fixed negotiation window for every fare-negotiation action (both apps). SSOT = 25 seconds. */
export const NEGOTIATION_COUNTDOWN_SECONDS = 25;

/** @deprecated Use `NEGOTIATION_COUNTDOWN_SECONDS` */
export const NEGOTIATION_SECONDS = NEGOTIATION_COUNTDOWN_SECONDS;

/** Alias for UI and edge functions. */
export const negotiationCountdownSeconds = NEGOTIATION_COUNTDOWN_SECONDS;

/** @deprecated Use `NEGOTIATION_COUNTDOWN_SECONDS` */
export const NEGOTIATION_TIMER_SECONDS = NEGOTIATION_COUNTDOWN_SECONDS;

/** @deprecated Use `NEGOTIATION_COUNTDOWN_SECONDS` */
export const NEGOTIATION_ACTION_EXTENSION_SEC = NEGOTIATION_COUNTDOWN_SECONDS;

/** Fixed deadline for a new negotiation action. */
export function negotiationExpiresAtIso(fromMs = Date.now()): string {
  return new Date(fromMs + NEGOTIATION_COUNTDOWN_SECONDS * 1000).toISOString();
}

/** UI countdown — caps display at NEGOTIATION_COUNTDOWN_SECONDS even when server deadline is farther out. */
export function calcNegotiationRemainingSec(
  negotiationExpiresAt: string | null | undefined,
): number {
  if (!negotiationExpiresAt) return NEGOTIATION_COUNTDOWN_SECONDS;
  const raw = Math.max(
    0,
    Math.ceil((new Date(negotiationExpiresAt).getTime() - Date.now()) / 1000),
  );
  return Math.min(NEGOTIATION_COUNTDOWN_SECONDS, raw);
}

/**
 * Next deadline after a negotiation action (driver counter window).
 * - At least `timeoutSec` from now
 * - Extends a still-future `currentExpiresAt` by `extensionSec`
 */
export function nextNegotiationExpiresAt(
  currentExpiresAt: string | null | undefined,
  timeoutSec: number,
  extensionSec = NEGOTIATION_COUNTDOWN_SECONDS,
): string {
  const now = Date.now();
  const floorMs = now + Math.max(timeoutSec, extensionSec) * 1000;
  let candidateMs = floorMs;
  if (currentExpiresAt) {
    const currentMs = new Date(currentExpiresAt).getTime();
    if (currentMs > now) {
      candidateMs = Math.max(candidateMs, currentMs + extensionSec * 1000);
    }
  }
  return new Date(candidateMs).toISOString();
}
