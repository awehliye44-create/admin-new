/**
 * DT1 — Durable Driver tip-received heads-up locks.
 * Separate from SN1.
 *
 * Run: deno test --allow-read supabase/tests/_shared/driverTipNotifyDurableDT1Lock.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildDriverTipNotificationId,
  decideDriverTipSendLease,
  driverTipReceivedCopy,
  formatDriverTipAmountGbp,
  isDriverTipNotificationId,
  isDriverTipNotifyObsolete,
  resolveDriverTipDeliveryOutcome,
  DT1_SEND_LEASE_MS,
  walletTipDeepLinkPath,
} from "../../functions/_shared/driverTipNotifyDurableSSOT.ts";

const LEDGER = "9c2aa313-dd50-4936-bd95-1accf6a29a4b";
const DRIVER = "c40dd8a6-f422-40bc-9534-bae7be88b93e";

Deno.test("DT1 notification id + copy + deep link", () => {
  assertEquals(
    buildDriverTipNotificationId(LEDGER),
    `driver_tip_received:${LEDGER}`,
  );
  assertEquals(isDriverTipNotificationId(`driver_tip_received:${LEDGER}`), true);
  assertEquals(formatDriverTipAmountGbp(576), "£5.76");
  const copy = driverTipReceivedCopy(576);
  assertEquals(copy.title, "🎉 You've received a £5.76 tip!");
  assertEquals(
    copy.body,
    "Your passenger appreciated your service. Send them a thank you! ❤️",
  );
  assertEquals(walletTipDeepLinkPath(LEDGER), `/wallet?ledgerId=${LEDGER}`);
});

Deno.test("DT1 lease: pending/failed reclaim; ambiguous terminal; no blind retry", () => {
  const now = 1_000_000;
  assertEquals(
    decideDriverTipSendLease({
      existing: { status: "pending", updatedAtIso: new Date(now).toISOString() },
      nowMs: now,
    }).action,
    "lease_sending",
  );
  assertEquals(
    decideDriverTipSendLease({
      existing: {
        status: "ambiguous",
        updatedAtIso: new Date(now).toISOString(),
        attempts: 1,
      },
      nowMs: now,
    }).action,
    "skip",
  );
  assertEquals(
    decideDriverTipSendLease({
      existing: {
        status: "sending",
        updatedAtIso: new Date(now - 1_000).toISOString(),
        attempts: 1,
      },
      nowMs: now,
    }).action,
    "skip",
  );
  assertEquals(
    decideDriverTipSendLease({
      existing: {
        status: "sending",
        updatedAtIso: new Date(now - DT1_SEND_LEASE_MS - 1).toISOString(),
        attempts: 1,
      },
      nowMs: now,
    }).action,
    "lease_sending",
  );
});

Deno.test("DT1 anti-stale requires live DRIVER_TIP_CREDIT ownership", () => {
  assertEquals(
    isDriverTipNotifyObsolete({
      ledger: {
        id: LEDGER,
        type: "DRIVER_TIP_CREDIT",
        driverId: DRIVER,
        amountPence: 200,
      },
      claimedDriverId: DRIVER,
      claimedLedgerId: LEDGER,
    }).obsolete,
    false,
  );
  assertEquals(
    isDriverTipNotifyObsolete({
      ledger: {
        id: LEDGER,
        type: "DRIVER_TIP_CREDIT",
        driverId: DRIVER,
        amountPence: 0,
      },
      claimedDriverId: DRIVER,
      claimedLedgerId: LEDGER,
    }).obsolete,
    true,
  );
  assertEquals(
    resolveDriverTipDeliveryOutcome({
      httpOk: true,
      sent: null,
      reason: null,
    }).status,
    "ambiguous",
  );
});

Deno.test("DT1 migration: trigger on tip credit; no historical backfill", async () => {
  const sql = await Deno.readTextFile(
    new URL(
      "../../migrations/20270305270000_dt1_driver_tip_notification_deliveries.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(sql, "driver_tip_notification_deliveries");
  assertStringIncludes(sql, "trg_dt1_driver_tip_credit_notify_intent");
  assertStringIncludes(sql, "DRIVER_TIP_CREDIT");
  assertStringIncludes(sql, "No historical backfill");
  assertEquals(sql.includes("INSERT INTO public.driver_tip_notification_deliveries"), true);
  // Must not seed from historical ledger rows.
  assertEquals(sql.includes("FROM public.driver_wallet_ledger"), false);
});

Deno.test("DT1 wiring: send-driver-notification + settlement kick + reclaim", async () => {
  const send = await Deno.readTextFile(
    new URL("../../functions/send-driver-notification/index.ts", import.meta.url),
  );
  assertStringIncludes(send, "DRIVER_TIP_RECEIVED");
  assertStringIncludes(send, "isDriverTipReceived");
  assertStringIncludes(send, '"interruption-level": "time-sensitive"');
  assertStringIncludes(send, 'priority: "HIGH"');

  const settle = await Deno.readTextFile(
    new URL(
      "../../functions/_shared/applyCanonicalSettlementAfterCapture.ts",
      import.meta.url,
    ),
  );
  assertStringIncludes(settle, "kickDriverTipReceivedDeliverForTrip");
  assertStringIncludes(settle, "dt1_driver_tip_notify");
  // Settlement math untouched — tip notify is after credit, tipPence > 0 only.
  assertStringIncludes(settle, "if (tipPence > 0)");

  const dispatch = await Deno.readTextFile(
    new URL("../../functions/scheduled-dispatch/index.ts", import.meta.url),
  );
  assertStringIncludes(dispatch, "reclaimPendingDriverTipNotifies");
  assertStringIncludes(dispatch, "dt1_tip_reclaim");
});

Deno.test("DT1 customer thank-you path still intact (Send thanks)", async () => {
  const thanks = await Deno.readTextFile(
    new URL("../../functions/send-tip-thanks/index.ts", import.meta.url),
  );
  assertStringIncludes(thanks, "dispatchCustomerPopup");
  assertStringIncludes(thanks, "send-customer-notification");
  assertStringIncludes(thanks, "driver_tip_thanks");
  const ssot = await Deno.readTextFile(
    new URL(
      "../../functions/send-tip-thanks/lib/driverTipThanksSSOT.ts",
      import.meta.url,
    ),
  );
  assertStringIncludes(ssot, "Thank you from your driver");
  assertStringIncludes(ssot, "Your driver appreciated your tip.");
});
