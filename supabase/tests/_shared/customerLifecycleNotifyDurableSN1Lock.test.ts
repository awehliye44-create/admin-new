/**
 * SN1 — Durable scheduled Customer lifecycle notify locks + MK-261128-003 fixture.
 *
 * Run: deno test --allow-read supabase/tests/_shared/customerLifecycleNotifyDurableSN1Lock.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildSn1NotificationId,
  decideLifecycleIntentPersist,
  decideLifecycleSendLease,
  isSn1LifecycleNotificationId,
  isSn1LifecycleNotifyObsolete,
  resolveLifecycleDeliveryOutcome,
  SN1_SEND_LEASE_MS,
} from "../../functions/_shared/customerLifecycleNotifyDurableSSOT.ts";

const TRIP_003 = "9c2aa313-dd50-4936-bd95-1accf6a29a4b";
const DRIVER = "c40dd8a6-f422-40bc-9534-bae7be88b93e";
const PASSENGER = "e6dac0bf-f57c-445d-adb9-26fcd0a2affc";

Deno.test("SN1 notification ids are stable and detectable", () => {
  const acceptId = buildSn1NotificationId("scheduled_accept", TRIP_003);
  assertEquals(acceptId, `driver_assigned-${TRIP_003}-scheduled_accept`);
  assertEquals(isSn1LifecycleNotificationId(acceptId), true);
  assertEquals(
    isSn1LifecycleNotificationId(`sn1:scheduled_booking_confirmed:${TRIP_003}`),
    true,
  );
  assertEquals(
    isSn1LifecycleNotificationId(`sn1:scheduled_converted_to_instant:${TRIP_003}`),
    true,
  );
  assertEquals(
    isSn1LifecycleNotificationId(`traffic_delay_scheduled:${TRIP_003}`),
    false,
  );
});

Deno.test("SN1 persist is idempotent once a claim exists", () => {
  assertEquals(
    decideLifecycleIntentPersist({ existing: null }).action,
    "insert_pending",
  );
  for (const status of ["pending", "sending", "sent", "skipped", "failed", "ambiguous"]) {
    assertEquals(
      decideLifecycleIntentPersist({ existing: { status } }).action,
      "already_durable",
    );
  }
});

Deno.test("SN1 lease reclaim: pending/failed/stale sending; in-flight skipped", () => {
  const now = 1_000_000;
  assertEquals(
    decideLifecycleSendLease({
      existing: { status: "pending", updatedAtIso: new Date(now).toISOString(), attempts: 0 },
      nowMs: now,
    }).action,
    "lease_sending",
  );
  assertEquals(
    decideLifecycleSendLease({
      existing: {
        status: "sending",
        updatedAtIso: new Date(now - SN1_SEND_LEASE_MS - 1).toISOString(),
        attempts: 1,
      },
      nowMs: now,
    }).action,
    "lease_sending",
  );
  const inflight = decideLifecycleSendLease({
    existing: {
      status: "sending",
      updatedAtIso: new Date(now - 1_000).toISOString(),
      attempts: 1,
    },
    nowMs: now,
  });
  assertEquals(inflight.action, "skip");
  if (inflight.action === "skip") assertEquals(inflight.reason, "in_flight");
  assertEquals(
    decideLifecycleSendLease({
      existing: { status: "sent", updatedAtIso: new Date(now).toISOString() },
      nowMs: now,
    }).action,
    "skip",
  );
});

Deno.test("SN1 MK-261128-003 anti-stale: preconfirm relevant then released/reassigned", () => {
  const ok = isSn1LifecycleNotifyObsolete({
    kind: "scheduled_accept",
    trip: {
      status: "scheduled",
      scheduledStatus: "driver_assigned",
      confirmedDriverId: DRIVER,
      driverId: null,
      passengerId: PASSENGER,
    },
    claimedPassengerId: PASSENGER,
    claimedConfirmedDriverId: DRIVER,
  });
  assertEquals(ok.obsolete, false);

  const released = isSn1LifecycleNotifyObsolete({
    kind: "scheduled_accept",
    trip: {
      status: "scheduled",
      scheduledStatus: "broadcasting",
      confirmedDriverId: null,
      driverId: null,
      passengerId: PASSENGER,
    },
    claimedPassengerId: PASSENGER,
    claimedConfirmedDriverId: DRIVER,
  });
  assertEquals(released.obsolete, true);
  assertEquals(released.reason, "preconfirm_released");

  const reassigned = isSn1LifecycleNotifyObsolete({
    kind: "scheduled_accept",
    trip: {
      status: "scheduled",
      scheduledStatus: "driver_assigned",
      confirmedDriverId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      driverId: null,
      passengerId: PASSENGER,
    },
    claimedPassengerId: PASSENGER,
    claimedConfirmedDriverId: DRIVER,
  });
  assertEquals(reassigned.obsolete, true);
  assertEquals(reassigned.reason, "driver_reassigned");

  const cancelled = isSn1LifecycleNotifyObsolete({
    kind: "scheduled_accept",
    trip: {
      status: "cancelled",
      scheduledStatus: "cancelled",
      confirmedDriverId: DRIVER,
      driverId: null,
      passengerId: PASSENGER,
    },
    claimedPassengerId: PASSENGER,
    claimedConfirmedDriverId: DRIVER,
  });
  assertEquals(cancelled.obsolete, true);
});

Deno.test("SN1 convert notify obsolete after assignment", () => {
  const searching = isSn1LifecycleNotifyObsolete({
    kind: "scheduled_converted_to_instant",
    trip: {
      status: "searching",
      scheduledStatus: "converted_to_instant",
      confirmedDriverId: null,
      driverId: null,
      passengerId: PASSENGER,
    },
    claimedPassengerId: PASSENGER,
  });
  assertEquals(searching.obsolete, false);

  const assigned = isSn1LifecycleNotifyObsolete({
    kind: "scheduled_converted_to_instant",
    trip: {
      status: "en_route_to_pickup",
      scheduledStatus: "converted_to_instant",
      confirmedDriverId: null,
      driverId: DRIVER,
      passengerId: PASSENGER,
    },
    claimedPassengerId: PASSENGER,
  });
  assertEquals(assigned.obsolete, true);
  assertEquals(assigned.reason, "already_assigned");
});

Deno.test("SN1 delivery outcome maps provider results without inventing heads-up", () => {
  assertEquals(
    resolveLifecycleDeliveryOutcome({ httpOk: true, sent: 1, reason: null }).status,
    "sent",
  );
  assertEquals(
    resolveLifecycleDeliveryOutcome({ httpOk: true, sent: 0, reason: "no_tokens" })
      .skippedReason,
    "no_tokens",
  );
  assertEquals(
    resolveLifecycleDeliveryOutcome({ httpOk: false, sent: null, reason: null }).status,
    "failed",
  );
  assertEquals(
    resolveLifecycleDeliveryOutcome({
      httpOk: true,
      sent: null,
      reason: null,
    }).status,
    "ambiguous",
  );
});

Deno.test("SN1 wiring: Accept persists intent on sync path; FCM stays background", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/scheduled-ride-action/index.ts", import.meta.url),
  );
  const acceptAt = src.indexOf('if (action === "accept")');
  const declineAt = src.indexOf('if (action === "decline")');
  const acceptBlock = src.slice(acceptAt, declineAt);
  assertStringIncludes(acceptBlock, "persistCustomerLifecycleNotifyIntent");
  assertStringIncludes(acceptBlock, 'kind: "scheduled_accept"');
  const syncTail = acceptBlock.slice(
    0,
    acceptBlock.indexOf("scheduleEdgeBackground(async () => {"),
  );
  assertStringIncludes(syncTail, "persistCustomerLifecycleNotifyIntent");
  assertEquals(syncTail.includes("deliverCustomerLifecycleNotifyByKind"), false);
  assertEquals(syncTail.includes("notifyCustomerTripLifecycle"), false);
  assertStringIncludes(acceptBlock, "deliverCustomerLifecycleNotifyByKind");
  assertStringIncludes(acceptBlock, "sn1_intent_ms");
});

Deno.test("SN1 wiring: CTAP persists booking-confirm intent before response", async () => {
  const ctap = await Deno.readTextFile(
    new URL("../../functions/create-trip-after-payment/index.ts", import.meta.url),
  );
  assertStringIncludes(ctap, "persistCustomerLifecycleNotifyIntent");
  assertStringIncludes(ctap, 'kind: "scheduled_booking_confirmed"');
  assertStringIncludes(ctap, "markPaymentSessionTripCreated");
  const post = await Deno.readTextFile(
    new URL(
      "../../functions/create-trip-after-payment/lib/bookingPostCommit.ts",
      import.meta.url,
    ),
  );
  assertStringIncludes(post, "deliverCustomerLifecycleNotifyByKind");
  assertStringIncludes(post, 'kind: "scheduled_booking_confirmed"');
});

Deno.test("SN1 wiring: scheduled-dispatch convert + reclaim", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/scheduled-dispatch/index.ts", import.meta.url),
  );
  assertStringIncludes(src, 'kind: "scheduled_converted_to_instant"');
  assertStringIncludes(src, "reclaimPendingCustomerLifecycleNotifies");
  assertStringIncludes(src, "persistCustomerLifecycleNotifyIntent");
});

Deno.test("SN1 send-trip-notification refuses missing durable claim", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/send-trip-notification/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "isSn1LifecycleNotificationId");
  assertStringIncludes(src, "missing_delivery_claim");
});

Deno.test("SN1 migration adds pending status", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20270305250000_sn1_customer_lifecycle_notify_pending.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(sql, "'pending'");
  assertStringIncludes(sql, "customer_trip_notification_deliveries_recovery_idx");
});
