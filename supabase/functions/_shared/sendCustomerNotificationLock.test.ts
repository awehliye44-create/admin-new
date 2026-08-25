/**
 * Lock: send-customer-notification accepts customers.id aliases and delivers
 * only to the sole authoritative device (auth.users.id).
 *
 * Run:
 *   deno test --allow-read supabase/functions/_shared/sendCustomerNotificationLock.test.ts
 *
 * Historical bug: scheduled-* / create-ride sent `passengerId` (customers.id)
 * while the Edge function required `customer_id` and looked up tokens by that
 * raw id — scheduled activation pushes never reached the Customer app.
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const ROOT = new URL("..", import.meta.url);

function read(rel: string): string {
  return Deno.readTextFileSync(new URL(rel, ROOT));
}

Deno.test("sendCustomerNotificationLock: accepts passengerId alias", () => {
  const src = read("./send-customer-notification/index.ts");
  assertStringIncludes(src, "passengerId");
  assertStringIncludes(src, "readCustomerIdHint");
  assertStringIncludes(src, '"customer_id"');
  assertStringIncludes(src, '"passengerId"');
});

Deno.test("sendCustomerNotificationLock: resolves customers.id → auth user + sole token", () => {
  const src = read("./send-customer-notification/index.ts");
  assertStringIncludes(src, "resolveCustomerAuthUserId");
  assertStringIncludes(src, "resolveCustomerAuthoritativeToken");
  assertStringIncludes(src, "authoritativeDevicePush.ts");
  // Must not fan-out via app_type query over all tokens.
  assertEquals(src.includes('.eq("app_type", "customer")'), false);
});

Deno.test("sendCustomerNotificationLock: scheduled callers pass customer_id", () => {
  const scheduledDispatch = read("./scheduled-dispatch/index.ts");
  const scheduleDispatch = read("./schedule-dispatch/index.ts");
  const checkin = read("./scheduled-checkin/index.ts");
  assertStringIncludes(scheduledDispatch, "customer_id: args.passengerId");
  assertStringIncludes(scheduleDispatch, "customer_id: trip.passenger_id");
  assertStringIncludes(checkin, "customer_id: trip.passenger_id");
  assertEquals(
    /invoke\("send-customer-notification"[\s\S]*?passengerId:\s*trip/.test(
      scheduleDispatch,
    ),
    false,
  );
});
