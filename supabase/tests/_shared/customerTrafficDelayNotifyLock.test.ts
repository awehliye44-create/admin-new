/**
 * LOCK — #79A scheduled traffic_delay one-shot durable delivery.
 *
 * Run:
 *   deno test -A --config supabase/functions/deno.json \
 *     supabase/tests/_shared/customerTrafficDelayNotifyLock.test.ts \
 *     supabase/tests/_shared/scheduledPostActivationRematch.execution.test.ts
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildScheduledTrafficDelayCopy,
  decideTrafficDelayClaim,
  isScheduledTrafficDelayObsolete,
  resolveTrafficDelayDeliveryOutcome,
  SCHEDULED_TRAFFIC_DELAY_BODY_EN_ROUTE,
  SCHEDULED_TRAFFIC_DELAY_BODY_GENERIC,
  SCHEDULED_TRAFFIC_DELAY_TITLE,
  TRAFFIC_DELAY_SEND_LEASE_MS,
  trafficDelayCollapseId,
} from "../../functions/scheduled-dispatch/lib/customerTrafficDelayNotifySSOT.ts";
import { buildTrafficDelayNotificationId } from "../../functions/scheduled-dispatch/lib/scheduledPostActivationLatenessSSOT.ts";

Deno.test("#79A copy: title + en-route body only when live en_route", () => {
  const enRoute = buildScheduledTrafficDelayCopy({ status: "en_route_to_pickup" });
  assertEquals(enRoute.title, SCHEDULED_TRAFFIC_DELAY_TITLE);
  assertEquals(enRoute.body, SCHEDULED_TRAFFIC_DELAY_BODY_EN_ROUTE);

  const arrived = buildScheduledTrafficDelayCopy({ status: "arrived_at_pickup" });
  assertEquals(arrived.title, SCHEDULED_TRAFFIC_DELAY_TITLE);
  assertEquals(arrived.body, SCHEDULED_TRAFFIC_DELAY_BODY_GENERIC);
});

Deno.test("#79A obsolete after arrival / cancel / complete", () => {
  assertEquals(
    isScheduledTrafficDelayObsolete({ status: "en_route_to_pickup" }),
    false,
  );
  for (const status of [
    "arrived_at_pickup",
    "in_progress",
    "completed",
    "cancelled",
  ]) {
    assertEquals(
      isScheduledTrafficDelayObsolete({ status }),
      true,
      `status=${status}`,
    );
  }
});

Deno.test("#79A claim: ten overdue evaluations → one insert_new then skip", () => {
  const decisions = [];
  let existing: { status: string; updatedAtIso: string } | null = null;
  const nowMs = Date.parse("2026-11-22T20:35:00.000Z");
  for (let i = 0; i < 10; i++) {
    const d = decideTrafficDelayClaim({
      existing,
      nowMs: nowMs + i * 60_000,
      obsolete: false,
    });
    decisions.push(d.action);
    if (d.action === "insert_new") {
      existing = {
        status: "sent",
        updatedAtIso: new Date(nowMs).toISOString(),
      };
    }
  }
  assertEquals(decisions[0], "insert_new");
  assertEquals(decisions.slice(1).every((a) => a === "skip"), true);
});

Deno.test("#79A claim: concurrent in-flight skip; lease reclaim; failed reclaim", () => {
  const nowMs = Date.parse("2026-11-22T20:35:00.000Z");
  assertEquals(
    decideTrafficDelayClaim({
      existing: {
        status: "sending",
        updatedAtIso: new Date(nowMs - 1_000).toISOString(),
      },
      nowMs,
      obsolete: false,
    }),
    { action: "skip", reason: "in_flight" },
  );
  assertEquals(
    decideTrafficDelayClaim({
      existing: {
        status: "sending",
        updatedAtIso: new Date(nowMs - TRAFFIC_DELAY_SEND_LEASE_MS - 1).toISOString(),
      },
      nowMs,
      obsolete: false,
    }),
    { action: "reclaim", reason: "sending_lease_expired" },
  );
  assertEquals(
    decideTrafficDelayClaim({
      existing: {
        status: "failed",
        updatedAtIso: new Date(nowMs - 5_000).toISOString(),
      },
      nowMs,
      obsolete: false,
    }),
    { action: "reclaim", reason: "failed" },
  );
  assertEquals(
    decideTrafficDelayClaim({
      existing: {
        status: "ambiguous",
        updatedAtIso: new Date(nowMs - 5_000).toISOString(),
      },
      nowMs,
      obsolete: false,
    }),
    { action: "skip", reason: "already_terminal" },
  );
  assertEquals(
    decideTrafficDelayClaim({
      existing: null,
      nowMs,
      obsolete: true,
    }),
    { action: "skip", reason: "obsolete" },
  );
});

Deno.test("#79A delivery outcomes: success / fail / no_tokens / ambiguous", () => {
  assertEquals(
    resolveTrafficDelayDeliveryOutcome({ httpOk: true, sent: 1, reason: null }),
    { status: "sent" },
  );
  assertEquals(
    resolveTrafficDelayDeliveryOutcome({
      httpOk: true,
      sent: 0,
      reason: "no_tokens",
    }),
    { status: "skipped", skippedReason: "no_tokens" },
  );
  assertEquals(
    resolveTrafficDelayDeliveryOutcome({ httpOk: false, sent: null, reason: null }),
    { status: "failed", errorMessage: "http_not_ok" },
  );
  assertEquals(
    resolveTrafficDelayDeliveryOutcome({
      httpOk: true,
      sent: null,
      reason: null,
    }),
    { status: "ambiguous", errorMessage: "provider_outcome_ambiguous" },
  );
  assertEquals(
    resolveTrafficDelayDeliveryOutcome({
      httpOk: true,
      sent: null,
      reason: null,
      throwError: true,
    }),
    { status: "failed", errorMessage: "notify_threw" },
  );
});

Deno.test("#79A collapse id stable + notification id prefix", () => {
  const id = buildTrafficDelayNotificationId("2490c572-b396-4351-b278-d3c8a4e3618e");
  assertEquals(id, "traffic_delay_scheduled:2490c572-b396-4351-b278-d3c8a4e3618e");
  assertEquals(trafficDelayCollapseId(id), id);
});

Deno.test("#79A source locks: STEP 1z uses claim; send-trip has collapse + ledger gate", async () => {
  const dispatch = await Deno.readTextFile(
    new URL("../../functions/scheduled-dispatch/index.ts", import.meta.url),
  );
  const notify = await Deno.readTextFile(
    new URL("../../functions/_shared/customerTrafficDelayNotify.ts", import.meta.url),
  );
  const sendTrip = await Deno.readTextFile(
    new URL("../../functions/send-trip-notification/index.ts", import.meta.url),
  );
  const migration = await Deno.readTextFile(
    new URL(
      "../../migrations/20270228120000_customer_trip_notification_deliveries.sql",
      import.meta.url,
    ),
  );
  const noDriverSrc = await Deno.readTextFile(
    new URL("../../functions/scheduled-dispatch/index.ts", import.meta.url),
  );

  assertStringIncludes(dispatch, "claimAndNotifyScheduledTrafficDelay");
  assertEquals(
    dispatch.includes('title: "Traffic Update"'),
    false,
    "must not use old Traffic Update title in STEP 1z",
  );
  assertEquals(
    /notifyCustomerTripLifecycle\(\s*supabase,\s*\{[^}]*event:\s*"traffic_delay"/s
      .test(dispatch),
    false,
    "STEP 1z must not call notifyCustomerTripLifecycle for traffic_delay directly",
  );
  assertStringIncludes(notify, "customer_trip_notification_deliveries");
  assertStringIncludes(notify, "claimAndNotifyScheduledTrafficDelay");
  assertStringIncludes(migration, "customer_trip_notification_deliveries");
  assertStringIncludes(migration, "UNIQUE (notification_id)");
  assertStringIncludes(migration, "historical_ops_alert_reconcile");
  assertStringIncludes(migration, "post_activation_lateness:");
  assertStringIncludes(sendTrip, "apns-collapse-id");
  assertStringIncludes(sendTrip, "missing_delivery_claim");
  assertStringIncludes(sendTrip, "already_");
  // Preserve NO_DRIVER_RISK stamp path.
  assertStringIncludes(noDriverSrc, "no_driver_customer_alert_sent_at");
  assertStringIncludes(noDriverSrc, "NO_DRIVER_RISK");
  // Priority must stay normal for traffic_delay.
  assertStringIncludes(sendTrip, "traffic_delay: 'normal'");
  assert(
    !sendTrip.includes("traffic_delay: 'high'"),
    "must not promote traffic_delay to high",
  );
});

Deno.test("#79A reassignment / scheduled-to-instant: notification id is trip-scoped only", () => {
  const tripId = "trip-abc";
  assertEquals(
    buildTrafficDelayNotificationId(tripId),
    "traffic_delay_scheduled:trip-abc",
  );
  // Same booking keeps same id regardless of driver or dispatch_mode — no driver/mode suffix.
  assertEquals(
    buildTrafficDelayNotificationId(tripId).includes("driver"),
    false,
  );
});
