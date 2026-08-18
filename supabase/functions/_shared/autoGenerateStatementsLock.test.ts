/**
 * auto-generate-statements: scheduled writes; TEN amounts must use shared aggregation.
 *
 * Run: deno test --allow-read --no-check supabase/functions/_shared/autoGenerateStatementsLock.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assertFalse } from "https://deno.land/std@0.224.0/assert/assert_false.ts";
import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/assert_string_includes.ts";

Deno.test("auto-generate-statements consumes shared invoice aggregation; no PS date selection", async () => {
  const src = await Deno.readTextFile(
    new URL("../auto-generate-statements/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "aggregateDriverInvoice");
  assertStringIncludes(src, "buildInvoiceItems");
  assertStringIncludes(src, "assertServiceRole");
  assertStringIncludes(src, "statement_schedule_configs");
  assertStringIncludes(src, "next_run_at");
  assertStringIncludes(src, 'if (config.next_run_at && new Date(config.next_run_at) > now)');
  assertEquals(src.includes('gte("created_at", periodStart)'), false);
  assertEquals(src.includes('lte("created_at", periodEnd'), false);
  assertFalse(src.includes(".from(\"payment_sessions\")"));
  assertFalse(src.includes("creditCapturedCardTripLedger"));
  assertFalse(src.includes("capturedTripWalletRecovery"));
  assertFalse(src.includes("api.revolut"));
  assertFalse(src.includes("loadEconomicEarnedAtEvidence"));
});

Deno.test("scheduled skip when next_run_at is in the future is the idempotency gate", async () => {
  const src = await Deno.readTextFile(
    new URL("../auto-generate-statements/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "continue; // Not time yet");
  assertStringIncludes(src, "generateDriverInvoicePdfOnly");
  assertStringIncludes(src, 'from("invoices")');
  assertStringIncludes(src, 'from("invoice_items")');
  assertStringIncludes(src, 'from("statement_runs")');
});

Deno.test("email/PDF boundaries: PDF via shared service; handler does not import resendMail", async () => {
  const src = await Deno.readTextFile(
    new URL("../auto-generate-statements/index.ts", import.meta.url),
  );
  assertFalse(src.includes("resendMail"));
  assertFalse(src.includes("sendResend"));
  assertStringIncludes(src, "is_auto_send_enabled");
});
