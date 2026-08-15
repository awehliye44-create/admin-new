/**
 * Lock: find-drivers boots against security.ts named exports.
 * Regression: voip+wallet commit dropped corsHeaders / dual errorResponse →
 * BOOT_ERROR → Customer Choose Ride "Unable to check availability" on every tier.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  corsHeaders,
  errorResponse,
  successResponse,
} from "./security.ts";

Deno.test("security exports corsHeaders required by find-drivers", () => {
  assertEquals(typeof corsHeaders["Access-Control-Allow-Origin"], "string");
  assertEquals(corsHeaders["Access-Control-Allow-Origin"], "*");
});

Deno.test("errorResponse accepts payment-style (message, status)", async () => {
  const res = errorResponse("Missing authorization header", 401);
  assertEquals(res.status, 401);
  const body = await res.json();
  assertEquals(body.success, false);
  assertEquals(body.error, "Missing authorization header");
});

Deno.test("errorResponse accepts code-style (code, message, status)", async () => {
  const res = errorResponse("OUTSIDE_RADIUS", "Too far", 400);
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body.code, "OUTSIDE_RADIUS");
  assertEquals(body.message, "Too far");
});

Deno.test("successResponse wraps object with success:true", async () => {
  const res = successResponse({ drivers: [] });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.success, true);
  assertEquals(Array.isArray(body.drivers), true);
});
