import { describe, expect, it } from "vitest";
import { savedTemplateHasPlaceholders, savedTemplatePrefill } from "../campaignSavedTemplatePrefill";

const base = {
  id: "1",
  name: "📢 ONECAB Service Update",
  category: "rider",
  title_template: "📢 ONECAB Service Update",
  message_template: "Scheduled bookings are now working as normal.",
};

describe("savedTemplatePrefill", () => {
  it("moves the leading emoji into the emoji field", () => {
    const p = savedTemplatePrefill(base);
    expect(p.emoji).toBe("📢");
    expect(p.title).toBe("ONECAB Service Update");
    expect(p.subtitle).toBe("Scheduled bookings are now working as normal.");
  });

  it("targets the Customer App for rider templates", () => {
    expect(savedTemplatePrefill(base).target_app).toBe("customer");
  });

  it("targets the Driver App for driver templates", () => {
    expect(savedTemplatePrefill({ ...base, category: "driver" }).target_app).toBe("driver");
  });

  it("leaves the chosen app unchanged for other categories", () => {
    expect(savedTemplatePrefill({ ...base, category: "system" }).target_app).toBeNull();
  });

  it("keeps a title without emoji as-is", () => {
    const p = savedTemplatePrefill({ ...base, title_template: "Service Update" });
    expect(p.emoji).toBeNull();
    expect(p.title).toBe("Service Update");
  });

  it("detects {{placeholders}}", () => {
    expect(savedTemplateHasPlaceholders({ ...base, message_template: "Hi {{name}}" })).toBe(true);
    expect(savedTemplateHasPlaceholders(base)).toBe(false);
  });
});
