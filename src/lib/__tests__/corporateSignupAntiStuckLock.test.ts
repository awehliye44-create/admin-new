/**
 * LOCK — Corporate account request signup must never silent-fail.
 * Edge returns actionable error codes + retry copy; success always includes request_id.
 * Web form lives in onecab-central-hub (submitCorporateAccountRequest).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const edge = readFileSync(
  join(
    __dirname,
    "../../../supabase/functions/submit-corporate-account-request/index.ts",
  ),
  "utf8",
);

describe("corporateSignupAntiStuckLock", () => {
  it("validation failures return retryable copy + codes", () => {
    expect(edge).toContain("Please check the form fields and try again.");
    expect(edge).toContain('code: "VALIDATION_FAILED"');
    expect(edge).toContain("codes: parsed.errors");
  });

  it("success confirms request_id and never returns empty success", () => {
    expect(edge).toContain("request_id: data.id");
    expect(edge).toContain("SUBMIT_UNCONFIRMED");
    expect(edge).toContain("Request received. ONECAB will contact you");
  });

  it("rate limit and internal errors tell the user to retry", () => {
    expect(edge).toContain("Too many requests. Please try again later.");
    expect(edge).toContain("Please try again in a moment.");
    expect(edge).toContain('code: "INTERNAL_ERROR"');
  });

  it("authenticated retries resume existing pending/approved request (idempotent)", () => {
    expect(edge).toContain("Idempotent resume");
    expect(edge).toContain('resumed: true');
    expect(edge).toContain('.in("status", ["pending", "approved"])');
    expect(edge).toContain('error.code === "23505"');
  });
});
