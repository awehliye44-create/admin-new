/**
 * Lock: Payment Sessions Captured column must not mislead on authorised holds.
 * - Overview must not show "Not recorded locally" + "AUTHORISED — ACTIVE" under Captured
 * - Uncaptured authorised → "—" (money cell only); lifecycle owns AUTHORISED
 *
 * Run: deno test --allow-read --no-check shared/__tests__/paymentSessionsCapturedColumnLock.deno.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { formatCapturedAmountDisplay } from "../paymentSessionsDisplaySSOT.ts";

const PS_PAGE = new URL("../../src/pages/PaymentSessions.tsx", import.meta.url);

Deno.test("PaymentSessions Captured column is money-only (no Not recorded locally stack)", async () => {
  const src = await Deno.readTextFile(PS_PAGE);
  assertEquals(src.includes("formatCapturedAmountDisplay"), false);
  assertEquals(/['"]Not recorded locally['"]/.test(src), false);
  // Captured cell uses nullable money formatter, not captureConfirmation.label under it.
  assertEquals(src.includes("formatNullablePence(row.captured_amount_pence)"), true);
});

Deno.test("formatCapturedAmountDisplay: authorised uncaptured → em dash, not Not recorded locally", () => {
  const fmt = (p: number | null) => (p == null ? "—" : `£${(p / 100).toFixed(2)}`);
  assertEquals(
    formatCapturedAmountDisplay({
      captured_amount_pence: null,
      currencyFormatter: fmt,
      provider_state: "AUTHORISED",
      capture_classification: "AUTHORISED_ACTIVE",
    }),
    "—",
  );
  assertEquals(
    formatCapturedAmountDisplay({
      captured_amount_pence: null,
      currencyFormatter: fmt,
    }),
    "—",
  );
});

Deno.test("formatCapturedAmountDisplay: provider captured without local amount → Not recorded locally", () => {
  const fmt = (p: number | null) => (p == null ? "—" : `£${(p / 100).toFixed(2)}`);
  assertEquals(
    formatCapturedAmountDisplay({
      captured_amount_pence: null,
      currencyFormatter: fmt,
      provider_state: "COMPLETED",
    }),
    "Not recorded locally",
  );
});

Deno.test("formatCapturedAmountDisplay: confirmed capture → money", () => {
  const fmt = (p: number | null) => (p == null ? "—" : `£${(p / 100).toFixed(2)}`);
  assertEquals(
    formatCapturedAmountDisplay({
      captured_amount_pence: 824,
      currencyFormatter: fmt,
      provider_state: "COMPLETED",
    }),
    "£8.24",
  );
});
