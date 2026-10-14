import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { AdminNotificationList } from "@/components/notifications/AdminNotificationList";
import {
  isRecoveryJobAlert,
  notificationDisplayState,
  sortActiveNotifications,
  type AdminNotificationRow,
} from "@/lib/adminNotificationList";

const RECOVERY_REASON =
  "The recovery check has not recorded a successful run for 12 minutes. No customer charge or driver credit was created.";

function row(overrides: Partial<AdminNotificationRow> = {}): AdminNotificationRow {
  return {
    id: "alert-1",
    type: "alert",
    category: "payment",
    title: "Waiting shortfall recovery has stopped",
    message: RECOVERY_REASON,
    priority: "urgent",
    target_audience: "admins",
    is_read: false,
    is_dismissed: false,
    action_url: "/notifications",
    action_label: "Open notifications",
    metadata: { alert_type: "SHORTFALL_RECOVERY_JOB_UNHEALTHY" },
    created_at: "2026-10-14T14:50:00.000Z",
    ...overrides,
  };
}

function renderList(active: AdminNotificationRow[], resolved: AdminNotificationRow[] = []) {
  return render(
    <MemoryRouter>
      <AdminNotificationList active={active} resolved={resolved} />
    </MemoryRouter>,
  );
}

describe("admin notification list", () => {
  it("shows the recovery-job reason, severity, time and unread state once", () => {
    renderList([row(), row()]);
    expect(screen.getAllByRole("heading", { name: "Waiting shortfall recovery has stopped" })).toHaveLength(1);
    expect(screen.getByText(RECOVERY_REASON)).toBeInTheDocument();
    expect(screen.getByText(/five-minute recovery check has not stored a successful run/)).toBeInTheDocument();
    expect(screen.getByText("urgent")).toBeInTheDocument();
    expect(screen.getByText("Unread")).toBeInTheDocument();
    expect(document.querySelector("time")).toHaveAttribute("dateTime", "2026-10-14T14:50:00.000Z");
    expect(screen.queryByRole("link", { name: "Open notifications" })).not.toBeInTheDocument();
  });

  it("puts the urgent recovery notice ahead of an ordinary notice", () => {
    const ordered = sortActiveNotifications([
      row({ id: "info", title: "Shift note", message: "Ordinary", priority: "normal", category: "system", metadata: {} }),
      row(),
    ]);
    expect(ordered.map((item) => item.id)).toEqual(["alert-1", "info"]);
  });

  it("keeps a cleared recovery notice and does not treat a driver row as that alert", () => {
    const cleared = row({
      id: "cleared-1",
      is_read: true,
      is_dismissed: true,
      metadata: {
        alert_type: "SHORTFALL_RECOVERY_JOB_UNHEALTHY",
        cleared_by: "verified_healthy_run",
      },
    });
    renderList([], [cleared]);
    expect(screen.getByText(RECOVERY_REASON)).toBeInTheDocument();
    expect(screen.getByText("Cleared")).toBeInTheDocument();
    expect(screen.getByText(/Cleared after a verified healthy recovery run/)).toBeInTheDocument();
    expect(notificationDisplayState(cleared)).toBe("cleared");

    const driverCopy = row({ id: "driver-1", target_audience: "drivers" });
    expect(isRecoveryJobAlert(driverCopy)).toBe(false);
  });

  it("keeps a dismissed notice visible as dismissed", () => {
    renderList([], [row({
      id: "old-1",
      title: "Older payment notice",
      message: "Kept for the record.",
      is_dismissed: true,
      is_read: true,
      metadata: {},
    })]);
    expect(screen.getByText("Older payment notice")).toBeInTheDocument();
    expect(screen.getByText("Kept for the record.")).toBeInTheDocument();
    expect(screen.getByText("Dismissed")).toBeInTheDocument();
  });
});
