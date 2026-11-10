import { describe, expect, it } from "vitest";
import {
  DEFAULT_DOCUMENT_REMINDER_DAYS,
  reminderDaysInputValue,
} from "@/lib/documentReminderDefaults";

describe("document reminder schedule defaults", () => {
  it("defaults to 7, 3, 1 days before expiry", () => {
    expect([...DEFAULT_DOCUMENT_REMINDER_DAYS]).toEqual([7, 3, 1]);
  });

  it("uses the default when a document type has no saved schedule", () => {
    expect(reminderDaysInputValue([])).toBe("7,3,1");
    expect(reminderDaysInputValue(null)).toBe("7,3,1");
  });

  it("keeps a saved custom schedule", () => {
    expect(reminderDaysInputValue([30, 14, 7])).toBe("30,14,7");
  });
});
