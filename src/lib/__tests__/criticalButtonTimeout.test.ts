import { describe, expect, it, vi } from "vitest";
import {
  CRITICAL_BUTTON_MAX_SPINNER_MS,
  CRITICAL_BUTTON_TIMEOUT_MESSAGE,
  logCriticalButtonTimeout,
} from "@/lib/criticalButtonTimeout";

describe("criticalButtonTimeoutSSOT", () => {
  it("caps spinner duration at 3 seconds", () => {
    expect(CRITICAL_BUTTON_MAX_SPINNER_MS).toBe(3_000);
  });

  it("uses a safe admin-facing timeout message", () => {
    expect(CRITICAL_BUTTON_TIMEOUT_MESSAGE).toMatch(/try again/i);
  });
});

describe("logCriticalButtonTimeout", () => {
  it("logs action and trip identifiers", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    logCriticalButtonTimeout({
      action: "admin_refresh_finance",
      durationMs: 3_001,
      tripId: null,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("CRITICAL_BUTTON_TIMEOUT"),
      expect.objectContaining({
        action: "admin_refresh_finance",
      }),
    );
    warn.mockRestore();
  });
});
