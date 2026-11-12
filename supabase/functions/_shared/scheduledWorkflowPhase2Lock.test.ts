/**
 * Phase 2 scheduled workflow repairs — deterministic source locks.
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

async function read(rel: string): Promise<string> {
  return await Deno.readTextFile(new URL(rel, import.meta.url));
}

Deno.test("scheduledDispatchWindowReached gates Make Available / payment_blocked", async () => {
  const src = await read("./activeTripRestoreCore.ts");
  assertStringIncludes(src, 'scheduledStatus === "scheduled"');
  assertStringIncludes(src, 'scheduledStatus === "pending"');
  assertStringIncludes(src, 'scheduledStatus === "payment_gate_blocked"');
  assertStringIncludes(src, "pickPreferredCustomerRestoreCandidate");
});

Deno.test("conversion patch can preserve airport broadcast hold", async () => {
  const src = await read("./scheduledDispatchConfig.ts");
  assertStringIncludes(src, "broadcastEnabled?: boolean");
  assertStringIncludes(src, "resolveConversionBroadcastEnabled");
  assertStringIncludes(src, "input.broadcastEnabled !== false");
});

Deno.test("scheduled-dispatch orders bounded STEP batches and holds airport Broadcast At", async () => {
  const src = await read("../scheduled-dispatch/index.ts");
  assertStringIncludes(src, '.order("pending_release_at", { ascending: true })');
  assertStringIncludes(src, '.order("scheduled_at", { ascending: true })');
  assertStringIncludes(src, "resolveConversionBroadcastEnabled");
  assertStringIncludes(src, "pending Broadcast At held");
});

Deno.test("cancel_confirmed rematch does not stamp terminal cancelled_at", async () => {
  const src = await read("../scheduled-ride-action/index.ts");
  assertStringIncludes(src, "cancelled_at: null");
  assertStringIncludes(src, "broadcast_enabled: true");
  assertStringIncludes(src, 'type: "scheduled_job_confirmed"');
  // Must not leave cancelled_at: releaseNowIso on rematch path.
  const rematchBlock = src.slice(src.indexOf('ACTION: CANCEL CONFIRMED'));
  assertEquals(rematchBlock.includes("cancelled_at: releaseNowIso"), false);
});
