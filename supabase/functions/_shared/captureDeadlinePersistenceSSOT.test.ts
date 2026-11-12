import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { extractCaptureDeadlineFromRevolutOrder } from "./captureDeadlinePersistenceSSOT.ts";
import { mergeCaptureDeadlinePersistence } from "./scheduledCaptureCoverageSSOT.ts";

Deno.test("extracts capture_deadline from order root", () => {
  const iso = extractCaptureDeadlineFromRevolutOrder({
    id: "ord_1",
    capture_deadline: "2026-06-11T12:00:00.000Z",
  });
  assertEquals(iso, "2026-06-11T12:00:00.000Z");
});

Deno.test("extracts capture_deadline from payments[] when root omitted", () => {
  const iso = extractCaptureDeadlineFromRevolutOrder({
    id: "ord_1",
    payments: [{ capture_deadline: "2026-06-12T08:00:00.000Z" }],
  });
  assertEquals(iso, "2026-06-12T08:00:00.000Z");
});

Deno.test("extracts capture_deadline from payments[].payment_method (Apple Pay nest)", () => {
  const iso = extractCaptureDeadlineFromRevolutOrder({
    id: "ord_1",
    payments: [{
      state: "authorised",
      payment_method: { capture_deadline: "2026-11-21T17:19:51.124Z" },
    }],
  });
  assertEquals(iso, "2026-11-21T17:19:51.124Z");
});

Deno.test("missing provider deadline followed by successful extract", () => {
  const missing = extractCaptureDeadlineFromRevolutOrder({ id: "ord_1" });
  assertEquals(missing, null);
  const after = extractCaptureDeadlineFromRevolutOrder({
    id: "ord_1",
    capture_deadline: "2026-06-11T12:00:00.000Z",
  });
  assertEquals(after, "2026-06-11T12:00:00.000Z");
});

Deno.test("merge never nulls out persisted deadline (webhook omit)", () => {
  const m = mergeCaptureDeadlinePersistence({
    existingDeadlineIso: "2026-06-11T12:00:00.000Z",
    providerDeadlineRaw: undefined,
    source: "provider_webhook",
  });
  assertEquals(m.captureDeadlineIso, "2026-06-11T12:00:00.000Z");
  assertEquals(m.changed, false);
});
