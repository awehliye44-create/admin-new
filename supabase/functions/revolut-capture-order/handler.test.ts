/**
 * Step 8.2A.1 — revolut-capture-order runtime handler behaviour.
 *
 * Run:
 *   deno test --allow-read --no-check --allow-env supabase/functions/revolut-capture-order/handler.test.ts
 */
import { assertEquals, assertStrictEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { handleRevolutCaptureOrderRequest } from "./index.ts";

Deno.test("unauthenticated request blocked by requireAdmin (not 410)", async () => {
  Deno.env.set("SUPABASE_URL", "https://example.supabase.co");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key");
  const res = await handleRevolutCaptureOrderRequest(
    new Request("https://example.com/revolut-capture-order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trip_id: "00000000-0000-0000-0000-000000000001", reason: "test block" }),
    }),
  );
  assertStrictEquals(res.status !== 410, true);
  assertStrictEquals(res.status >= 400, true);
});

Deno.test("handler source has no provider or DB imports", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assertEquals(src.includes("captureRevolutOrder"), false);
  assertEquals(src.includes("retrieveRevolutOrder"), false);
  assertEquals(src.includes('from("trips")'), false);
  assertEquals(src.includes("LEGACY_CAPTURE_ENDPOINT_DISABLED"), true);
});
