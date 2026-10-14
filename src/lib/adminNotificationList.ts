/** Display helpers for the existing Admin notifications inbox. */

export const RECOVERY_JOB_ALERT_TYPE = "SHORTFALL_RECOVERY_JOB_UNHEALTHY";
export const RECOVERY_JOB_CLEARED_BY = "verified_healthy_run";

export type AdminNotificationRow = {
  id: string;
  type: string;
  category: string;
  title: string;
  message: string;
  priority: string;
  target_audience: string;
  is_read: boolean;
  is_dismissed: boolean;
  action_url: string | null;
  action_label: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

const PRIORITY_RANK: Record<string, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export function notificationAlertType(row: AdminNotificationRow): string | null {
  const value = row.metadata?.alert_type;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function isRecoveryJobAlert(row: AdminNotificationRow): boolean {
  return row.target_audience === "admins" && notificationAlertType(row) === RECOVERY_JOB_ALERT_TYPE;
}

/** Active alerts first: the recovery-job notice, then urgent payment notices. */
export function sortActiveNotifications(rows: AdminNotificationRow[]): AdminNotificationRow[] {
  const unique: AdminNotificationRow[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    unique.push(row);
  }
  return unique.sort((a, b) => {
    const recovery = Number(isRecoveryJobAlert(b)) - Number(isRecoveryJobAlert(a));
    if (recovery !== 0) return recovery;
    const priority = (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);
    if (priority !== 0) return priority;
    const payment = Number(b.category === "payment") - Number(a.category === "payment");
    if (payment !== 0) return payment;
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  });
}

export type NotificationDisplayState = "unread" | "read" | "cleared" | "dismissed";

export function notificationDisplayState(row: AdminNotificationRow): NotificationDisplayState {
  if (!row.is_dismissed) return row.is_read ? "read" : "unread";
  return row.metadata?.cleared_by === RECOVERY_JOB_CLEARED_BY ? "cleared" : "dismissed";
}

export function notificationStateLabel(state: NotificationDisplayState): string {
  switch (state) {
    case "unread":
      return "Unread";
    case "read":
      return "Read";
    case "cleared":
      return "Cleared";
    case "dismissed":
      return "Dismissed";
  }
}

export function recoveryJobExplanation(row: AdminNotificationRow): string | null {
  if (!isRecoveryJobAlert(row)) return null;
  if (notificationDisplayState(row) === "cleared") {
    return "Cleared after a verified healthy recovery run. The original notice is kept here and was not deleted.";
  }
  return "The five-minute recovery check has not stored a successful run for 12 minutes. No new customer charge, capture, refund, or driver credit was created. This notice stays open until a later check records a successful run.";
}

/** A link is useful when it leaves this page. The inbox itself is not an action. */
export function notificationAction(row: AdminNotificationRow): { href: string; label: string } | null {
  const href = row.action_url?.trim() ?? "";
  if (!href || href === "/notifications") return null;
  return { href, label: row.action_label?.trim() || "Open" };
}
