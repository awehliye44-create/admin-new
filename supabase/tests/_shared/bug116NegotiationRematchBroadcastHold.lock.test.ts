/**
 * #116 lock — negotiation rematch must reopen broadcast when no hold is active.
 *
 * MK-261126-009: trips_enforce_airport_broadcast_hold ELSE forced
 * broadcast_enabled=false on every false→true transition, so
 * finalize_negotiation_failure rematch stayed LOCKED_DRIVER_TRIP.
 */
import {
  assertStringIncludes,
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { driverNetPenceFromOfferContext } from "../../functions/_shared/driverOfferPushCopy.ts";

const MIGRATION_116 =
  "../../migrations/20270304120000_bug116_negotiation_rematch_broadcast_reopen.sql";
const ORIGINAL_HOLD =
  "../../migrations/20270213120000_scheduled_marketplace_hold_reason.sql";
const PARITY_SYNC =
  "../trips_update_trigger_fn_body_sync_110_local.sql";
const PARITY_LOCAL =
  "../trips_update_trigger_parity_110_local.sql";
const AUTO_DISPATCH = "../../functions/auto-dispatch/index.ts";

Deno.test("#116 migration narrows broadcast hold reopen refuse", async () => {
  const sql = await Deno.readTextFile(new URL(MIGRATION_116, import.meta.url));
  assertStringIncludes(sql, "trips_enforce_airport_broadcast_hold");
  assertStringIncludes(
    sql,
    "ELSIF COALESCE(NEW.scheduled_hold_reason, OLD.scheduled_hold_reason, '') <> '' THEN",
  );
  assertStringIncludes(sql, "scheduled_hold_reason IS NULL → allow reopen");
  // Must NOT keep the blanket ELSE refuse from 20270213120000.
  assert(
    !sql.includes("ELSE\n      NEW.broadcast_enabled := FALSE;"),
    "must not restore blanket ELSE refuse of broadcast reopen",
  );
});

Deno.test("#116 parity sync bodies match rematch-safe hold trigger", async () => {
  const sync = await Deno.readTextFile(new URL(PARITY_SYNC, import.meta.url));
  const local = await Deno.readTextFile(new URL(PARITY_LOCAL, import.meta.url));
  for (const body of [sync, local]) {
    assertStringIncludes(
      body,
      "ELSIF COALESCE(NEW.scheduled_hold_reason, OLD.scheduled_hold_reason, '') <> '' THEN",
    );
    assert(
      !/ELSE\s+NEW\.broadcast_enabled := FALSE;/.test(
        body.slice(
          body.indexOf("trips_enforce_airport_broadcast_hold"),
          body.indexOf("trips_enforce_airport_broadcast_hold") + 1200,
        ),
      ),
      "parity body must not blanket-refuse reopen",
    );
  }
});

Deno.test("#116 original airport hold migration remains the refuse baseline for airport_pricing", async () => {
  const sql = await Deno.readTextFile(new URL(ORIGINAL_HOLD, import.meta.url));
  assertStringIncludes(sql, "airport_pricing");
  assertStringIncludes(sql, "onecab.release_airport_broadcast_hold");
});

Deno.test("#116 auto-dispatch carries offered net into createdOffers for push", async () => {
  const src = await Deno.readTextFile(new URL(AUTO_DISPATCH, import.meta.url));
  assertStringIncludes(src, "offered_driver_net_pence: row?.offered_driver_net_pence");
  assertStringIncludes(src, "offer_snapshot: (row?.offer_snapshot");
  assertStringIncludes(src, "offeredDriverNetPence: offer.offered_driver_net_pence");
});

Deno.test("#116 driverNetPenceFromOfferContext prefers offeredDriverNetPence", () => {
  assertEquals(
    driverNetPenceFromOfferContext({
      offeredDriverNetPence: 430,
      offerSnapshot: null,
      trip: null,
    }),
    430,
  );
  assertEquals(
    driverNetPenceFromOfferContext({
      offerSnapshot: { driver_net_fare_pence: 507 },
      trip: null,
    }),
    507,
  );
  assertEquals(
    driverNetPenceFromOfferContext({
      offerSnapshot: {},
      trip: null,
    }),
    null,
  );
});
