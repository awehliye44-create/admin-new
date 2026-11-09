/**
 * LOCK — Corporate web Guard (onecab-central-hub) must never fake "successfully submitted".
 * Clone path: /Users/admin/onecab-central-hub (symlink → working tree).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const HUB = "/Users/admin/onecab-central-hub";

describe("corporateHubSignupAntiStuckLock", () => {
  it("hub clone is present for Corporate Guard SSOT", () => {
    expect(existsSync(join(HUB, "src/components/corporate/CorporateGuard.tsx"))).toBe(
      true,
    );
  });

  it("Guard never claims successful submit without a request row", () => {
    const guard = readFileSync(
      join(HUB, "src/components/corporate/CorporateGuard.tsx"),
      "utf8",
    );
    expect(guard).not.toContain(
      "Your corporate registration has been successfully submitted.",
    );
    expect(guard).toContain("Finish corporate registration");
    expect(guard).toContain("Continue registration");
    expect(guard).toContain("Could not load registration status");
    expect(guard).toContain("Try again");
  });

  it("Register guides email-confirm and submit failure without fake pending", () => {
    const index = readFileSync(join(HUB, "src/pages/Index.tsx"), "utf8");
    expect(index).toContain("Confirm your email");
    expect(index).toContain(
      "Sign in with this email and complete Create Corporate Account again",
    );
    expect(index).toContain('searchParams.get("finish") !== "1"');
    expect(index).toContain("alreadySignedIn");
  });

  it("Guard orphan CTA routes to finish=1 Create form", () => {
    const guard = readFileSync(
      join(HUB, "src/components/corporate/CorporateGuard.tsx"),
      "utf8",
    );
    expect(guard).toContain('navigate("/?finish=1")');
  });
});
