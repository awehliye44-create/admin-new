import { Link } from "react-router-dom";
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import {
  notificationAction,
  notificationDisplayState,
  notificationStateLabel,
  recoveryJobExplanation,
  sortActiveNotifications,
  type AdminNotificationRow,
} from "@/lib/adminNotificationList";

const PRIORITY_CLASS: Record<string, string> = {
  low: "bg-slate-100 text-slate-700",
  normal: "bg-blue-100 text-blue-700",
  high: "bg-orange-100 text-orange-700",
  urgent: "bg-red-100 text-red-700",
};

function formatCreatedAt(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return format(parsed, "dd MMM yyyy, HH:mm");
}

function NotificationCard({ row }: { row: AdminNotificationRow }) {
  const state = notificationDisplayState(row);
  const explanation = recoveryJobExplanation(row);
  const action = notificationAction(row);
  const severity = row.priority || "normal";

  return (
    <article className="rounded-lg border bg-card p-4" data-notification-id={row.id}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <h3 className="text-base font-semibold text-foreground">{row.title}</h3>
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline" className={PRIORITY_CLASS[severity] ?? ""}>
            {severity}
          </Badge>
          <Badge variant={state === "unread" ? "default" : "secondary"}>
            {notificationStateLabel(state)}
          </Badge>
        </div>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        <time dateTime={row.created_at}>{formatCreatedAt(row.created_at)}</time>
        {row.category ? ` · ${row.category}` : ""}
      </p>
      <p className="mt-3 whitespace-pre-wrap text-sm text-foreground">{row.message}</p>
      {explanation ? <p className="mt-3 text-sm text-foreground">{explanation}</p> : null}
      {action ? (
        <p className="mt-3">
          <Link className="text-sm font-medium underline" to={action.href}>
            {action.label}
          </Link>
        </p>
      ) : null}
    </article>
  );
}

export function AdminNotificationList({
  active,
  resolved,
}: {
  active: AdminNotificationRow[];
  resolved: AdminNotificationRow[];
}) {
  const visibleActive = sortActiveNotifications(active);
  const visibleResolved = [...resolved]
    .filter((row, index, all) => all.findIndex((item) => item.id === row.id) === index)
    .sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
  const activeIds = new Set(visibleActive.map((row) => row.id));

  return (
    <section className="mb-6 space-y-4" aria-label="Administrator alerts">
      <div>
        <h2 className="text-lg font-semibold">Alerts</h2>
        <p className="text-sm text-muted-foreground">
          Open notices for administrators. Urgent payment alerts are listed first.
        </p>
      </div>
      {visibleActive.length === 0 ? (
        <p className="text-sm text-muted-foreground">No open alerts.</p>
      ) : (
        <div className="space-y-3">
          {visibleActive.map((row) => (
            <NotificationCard key={row.id} row={row} />
          ))}
        </div>
      )}
      {visibleResolved.length > 0 ? (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">Resolved and dismissed</h2>
          <p className="text-sm text-muted-foreground">
            These notices stay on record. Closing one does not delete it.
          </p>
          {visibleResolved
            .filter((row) => !activeIds.has(row.id))
            .map((row) => (
              <NotificationCard key={row.id} row={row} />
            ))}
        </div>
      ) : null}
    </section>
  );
}
