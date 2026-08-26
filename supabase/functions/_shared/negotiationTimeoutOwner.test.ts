import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  clientLocalCountdownMayMutateNegotiation,
  expireOffersSweepSeesLiveNegotiation,
  NEGOTIATION_TIMEOUT_OWNER,
  waitingCustomerExpiryAction,
} from "./negotiationTimeoutOwner.ts";
import { negotiationDeadlineIso } from "./negotiation-deadline.ts";

const nowIso = "2026-08-25T19:00:00.000Z";
const pastIso = "2026-08-25T18:59:35.000Z";
const futureIso = "2026-08-25T19:00:25.000Z";

function read(rel: string): Promise<string> {
  return Deno.readTextFile(new URL(rel, import.meta.url));
}

Deno.test("Admin countdown 25 drives £Y, second-chance £X, and £Z windows", () => {
  const from = Date.parse("2026-08-14T18:00:00.000Z");
  assertEquals(negotiationDeadlineIso(25, from), "2026-08-14T18:00:25.000Z");
});

Deno.test("Customer £Y timeout is second chance, never rematch", () => {
  assertEquals(
    waitingCustomerExpiryAction({
      negotiationStatus: "waiting_customer",
      driverId: "drv-1",
    }),
    "second_chance",
  );
  assertEquals(
    waitingCustomerExpiryAction({
      negotiationStatus: "waiting_driver_final",
      driverId: "drv-1",
    }),
    "skip",
  );
});

Deno.test("expire-offers work-gate sees countered + negotiating deadlines", () => {
  assertEquals(
    expireOffersSweepSeesLiveNegotiation({
      offerStatus: "countered",
      tripStatus: "negotiating",
      dispatchStatus: "paused",
      negotiationStatus: "waiting_customer",
      customerRespondByIso: pastIso,
      nowIso,
    }),
    true,
  );
  assertEquals(
    expireOffersSweepSeesLiveNegotiation({
      offerStatus: "countered",
      tripStatus: "negotiating",
      negotiationStatus: "declined_customer_awaiting_driver",
      graceWindowExpiresAtIso: pastIso,
      nowIso,
    }),
    true,
  );
  assertEquals(
    expireOffersSweepSeesLiveNegotiation({
      offerStatus: "countered",
      tripStatus: "negotiating",
      negotiationStatus: "waiting_driver_final",
      driverRespondByIso: pastIso,
      nowIso,
    }),
    true,
  );
  assertEquals(
    expireOffersSweepSeesLiveNegotiation({
      offerStatus: "countered",
      tripStatus: "negotiating",
      negotiationStatus: "waiting_customer",
      customerRespondByIso: futureIso,
      nowIso,
    }),
    false,
  );
  assertEquals(
    expireOffersSweepSeesLiveNegotiation({
      offerStatus: "expired",
      negotiationStatus: "waiting_customer",
      customerRespondByIso: pastIso,
      nowIso,
    }),
    false,
  );
});

Deno.test("local countdown must not mutate negotiation", () => {
  assertEquals(clientLocalCountdownMayMutateNegotiation(), false);
  assertEquals(NEGOTIATION_TIMEOUT_OWNER, "expire-offers");
});

Deno.test("expire-offers owns all live negotiation timeouts; syncs defer", async () => {
  const expire = await read("../expire-offers/index.ts");
  const customerSync = await read("../customer-negotiation-sync/index.ts");
  const driverSync = await read("../driver-negotiation-sync/index.ts");
  const decision = await read("../customer-fare-decision/index.ts");
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20261026120000_preset_negotiation_timeout_owner_atomic_counter.sql",
      import.meta.url,
    ),
  );

  assertEquals(expire.includes("enterDriverSecondChanceAtOriginalFare"), true);
  assertEquals(expire.includes("waitingCustomerExpiryAction"), true);
  assertEquals(expire.includes('reason: "timeout_customer"'), true);
  assertEquals(expire.includes("Customer response timeout → Driver second chance £X"), true);
  assertEquals(expire.includes("Stuck waiting_customer → Driver second chance £X"), true);
  const timeoutChunk = expire.slice(
    expire.indexOf("Customer response timeout → Driver second chance £X") - 400,
    expire.indexOf("Customer response timeout → Driver second chance £X") + 80,
  );
  assertEquals(timeoutChunk.includes("finalizeNegotiationFailureAndRebroadcast"), false);
  const stuckChunk = expire.slice(
    expire.indexOf("Stuck waiting_customer → Driver second chance £X") - 400,
    expire.indexOf("Stuck waiting_customer → Driver second chance £X") + 80,
  );
  assertEquals(stuckChunk.includes("finalizeNegotiationFailureAndRebroadcast"), false);

  assertEquals(customerSync.includes("finalizeNegotiationFailureAndRebroadcast"), false);
  assertEquals(driverSync.includes("finalizeNegotiationFailureAndRebroadcast"), false);
  assertEquals(customerSync.includes("awaiting_timeout_owner"), true);
  assertEquals(driverSync.includes("awaiting_timeout_owner"), true);

  assertEquals(sql.includes("expire_offers_owns_timeouts"), true);
  assertEquals(sql.includes("SELECT false;"), true);
  assertEquals(sql.includes("ro.status IN ('pending', 'countered')"), true);
  assertEquals(sql.includes("t.status = 'negotiating'"), true);
  assertEquals(sql.includes("CREATE OR REPLACE FUNCTION public.resolve_negotiation_rebroadcast_fare"), true);
  assertEquals(sql.includes("CREATE OR REPLACE FUNCTION public.customer_counter_ride_offer"), true);
  assertEquals(sql.includes("RAISE EXCEPTION 'FARE_COMMIT_FAILED'"), true);
  assertEquals(sql.includes("LEAST(120, GREATEST(5, v_cd_secs))"), true);

  const actorSql = await Deno.readTextFile(
    new URL(
      "../../migrations/20261026130000_customer_counter_ride_offer_actor_check.sql",
      import.meta.url,
    ),
  );
  assertEquals(actorSql.includes("RAISE EXCEPTION 'customer_required'"), true);
  assertEquals(actorSql.includes("RAISE EXCEPTION 'forbidden_customer'"), true);
  assertEquals(actorSql.includes("RAISE EXCEPTION 'FARE_COMMIT_FAILED'"), true);
  assertEquals(actorSql.includes("DROP FUNCTION IF EXISTS public.customer_counter_ride_offer(uuid, integer)"), true);

  const cronSql = await Deno.readTextFile(
    new URL(
      "../../migrations/20261026140000_unschedule_stale_negotiation_cron.sql",
      import.meta.url,
    ),
  );
  assertEquals(cronSql.includes("cron.unschedule('expire_stale_negotiations_15s')"), true);
  assertEquals(cronSql.includes("expire_stale_negotiations_guarded"), true);
  assertEquals(cronSql.includes("expire_offers_owns_timeouts"), true);

  const restore = await read("../restore-active-trip/index.ts");
  assertEquals(restore.includes("negotiation = negotiation"), true);
  assertEquals(restore.includes("if (negotiation) {"), false);
  assertEquals(restore.includes("negotiating ? null"), true);
  assertEquals(restore.includes("negotiation_locked_until"), true);
  assertEquals(restore.includes("negotiation_disabled"), true);

  assertEquals(decision.includes("customer_counter_ride_offer"), true);
  assertEquals(decision.includes("p_actor_user_id: user.id"), true);
  assertEquals(decision.includes("p_customer_id: customerRecordId"), true);
  assertEquals(decision.includes('p_fare_source: "customer_counter_offer"'), false);
  assertEquals(decision.includes("Counter-offer recorded but committed fare"), false);
});

Deno.test("£X / £Y / £Z accepts stay on accept_ride_offer", async () => {
  const accept = await read("../accept-offer/index.ts");
  const decision = await read("../customer-fare-decision/index.ts");
  const final = await read("../driver-fare-final/index.ts");
  assertEquals(accept.includes("accept_ride_offer"), true);
  assertEquals(decision.includes("accept_ride_offer"), true);
  assertEquals(final.includes("accept_ride_offer"), true);
});

Deno.test("rebroadcast fare SQL: £Z if submitted else £X", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20261026120000_preset_negotiation_timeout_owner_atomic_counter.sql",
      import.meta.url,
    ),
  );
  assertEquals(sql.includes("customer_counter_fare"), true);
  assertEquals(sql.includes("trip_negotiation_base_fare_pence"), true);
  assertEquals(sql.includes("'fare_source', 'customer_counter_offer'"), true);
  assertEquals(sql.includes("'fare_source', 'original_fare'"), true);
});
