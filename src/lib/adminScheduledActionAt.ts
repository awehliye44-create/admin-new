/** Admin Assign At / Broadcast At / Jobs At: NOW < action_at < scheduled_at */
export function validateAdminScheduledActionAt(input: {
  actionAtIsoOrLocal: string;
  scheduledAt: string | null | undefined;
  nowMs?: number;
}): { ok: true; actionAt: Date } | { ok: false; error: string } {
  const nowMs = input.nowMs ?? Date.now();
  const actionAt = new Date(input.actionAtIsoOrLocal);
  if (!Number.isFinite(actionAt.getTime())) {
    return { ok: false, error: 'Choose a valid time' };
  }
  if (actionAt.getTime() <= nowMs) {
    return { ok: false, error: 'Time must be in the future' };
  }
  if (!input.scheduledAt) {
    return { ok: false, error: 'Trip has no scheduled pickup time' };
  }
  const pickupMs = Date.parse(String(input.scheduledAt));
  if (!Number.isFinite(pickupMs)) {
    return { ok: false, error: 'Trip has an invalid scheduled pickup time' };
  }
  if (actionAt.getTime() >= pickupMs) {
    return { ok: false, error: 'Time must be before scheduled pickup' };
  }
  return { ok: true, actionAt };
}
