/**
 * Customer non-accept of Driver £Y converges on one Driver second chance at £X.
 * Run: deno test --allow-read supabase/functions/_shared/driverSecondChanceOriginalFareLock.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildCustomerNegotiationView } from "./customerNegotiationView.ts";
import { DRIVER_SECOND_CHANCE_PHASE } from "./customerNegotiationGrace.ts";

Deno.test("second-chance phase reuses declined_customer_awaiting_driver", () => {
  assertEquals(DRIVER_SECOND_CHANCE_PHASE, "declined_customer_awaiting_driver");
});

Deno.test("Customer view hides negotiation controls during Driver second chance", () => {
  const view = buildCustomerNegotiationView({
    offer: {
      id: "offer-1",
      negotiation_status: "declined_customer_awaiting_driver",
      driver_offer_fare: 650,
      offer_snapshot: { countdown_seconds: 25 },
    },
    originalFarePence: 450,
  });
  assertEquals(view, null);
});

Deno.test("Decline, timeout, and ignore share one enterDriverSecondChance helper", async () => {
  const decision = await Deno.readTextFile(
    new URL("../customer-fare-decision/index.ts", import.meta.url),
  );
  const expire = await Deno.readTextFile(
    new URL("../expire-offers/index.ts", import.meta.url),
  );
  const sync = await Deno.readTextFile(
    new URL("../customer-negotiation-sync/index.ts", import.meta.url),
  );
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20260925140000_driver_second_chance_original_fare.sql",
      import.meta.url,
    ),
  );
  const grace = await Deno.readTextFile(
    new URL("./customerNegotiationGrace.ts", import.meta.url),
  );

  const driverSync = await Deno.readTextFile(
    new URL("../driver-negotiation-sync/index.ts", import.meta.url),
  );

  assertEquals(decision.includes("enterDriverSecondChanceAtOriginalFare"), true);
  assertEquals(expire.includes("enterDriverSecondChanceAtOriginalFare"), true);
  assertEquals(sync.includes("enterDriverSecondChanceAtOriginalFare"), true);
  assertEquals(driverSync.includes("enterDriverSecondChanceAtOriginalFare"), true);
  assertEquals(driverSync.includes("customer_timeout_rebroadcast"), false);
  assertEquals(sql.includes("apply_customer_decline_grace"), true);
  assertEquals(sql.includes("timeout_customer_second_chance"), true);
  assertEquals(sql.includes("preset_offer_configs"), true);
  assertEquals(sql.includes("interval '25 seconds'"), false);
  const continuitySql = await Deno.readTextFile(
    new URL(
      "../../migrations/20260925150000_negotiation_continuity_pending_timeout_owner.sql",
      import.meta.url,
    ),
  );
  assertEquals(continuitySql.includes("timeout_customer_second_chance"), false);
  assertEquals(
    continuitySql.includes("expire-offers → enterDriverSecondChanceAtOriginalFare"),
    true,
  );
  assertEquals(continuitySql.includes("declined_customer_awaiting_driver"), true);
  assertEquals(continuitySql.includes("ro.expires_at > now()"), true);
  assertEquals(grace.includes("apply_customer_decline_grace"), true);
  assertEquals(grace.includes("!grace.already"), true);
  assertEquals(decision.includes('offerNegotiationStatus: "declined_customer"'), false);
  assertEquals(
    expire.includes('offerNegotiationStatus: "timeout_customer"') &&
      expire.includes("enterDriverSecondChanceAtOriginalFare"),
    true,
  );
});

Deno.test("Driver Accept £X reuses accept_ride_offer; Decline rematches once", async () => {
  const final = await Deno.readTextFile(
    new URL("../driver-fare-final/index.ts", import.meta.url),
  );
  assertEquals(final.includes('negotiation_status === "declined_customer_awaiting_driver"'), true);
  assertEquals(final.includes("accept_ride_offer"), true);
  assertEquals(final.includes('fareSource: "original_fare"'), true);
  assertEquals(final.includes("finalizeNegotiationFailureAndRebroadcast"), true);
  assertEquals(final.includes("Customer declined — this trip was offered to other drivers"), false);
});

Deno.test("generic accept-offer cannot assign during Driver second chance", async () => {
  const accept = await Deno.readTextFile(
    new URL("../accept-offer/index.ts", import.meta.url),
  );
  assertEquals(accept.includes("BLOCKED_SECOND_CHANCE_USE_FARE_FINAL"), true);
  assertEquals(accept.includes("NEGOTIATION_HELD"), true);
});

Deno.test("Customer £Y timeout has one cron owner; pending RPC keeps active negotiation", async () => {
  const expire = await Deno.readTextFile(
    new URL("../expire-offers/index.ts", import.meta.url),
  );
  const send = await Deno.readTextFile(
    new URL("../send-driver-notification/index.ts", import.meta.url),
  );
  const continuitySql = await Deno.readTextFile(
    new URL(
      "../../migrations/20260925150000_negotiation_continuity_pending_timeout_owner.sql",
      import.meta.url,
    ),
  );
  assertEquals(expire.includes("enterDriverSecondChanceAtOriginalFare"), true);
  assertEquals(continuitySql.includes("apply_customer_decline_grace"), false);
  assertEquals(
    continuitySql.includes("AND responded_at IS NULL"),
    false,
  );
  assertEquals(
    continuitySql.includes("status = 'countered'") ||
      continuitySql.includes("ro.status = 'countered'"),
    true,
  );
  assertEquals(send.includes("incomingData.notificationType"), true);
  assertEquals(send.includes("incomingData.notification_type"), true);
});

