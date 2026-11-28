/**
 * #93B / #98 — TRIP_EARNING_PENDING → RELEASE → TEN lock.
 *
 * Run: deno test --allow-read --no-check supabase/tests/_shared/tripEarningPending98Lock.test.ts
 */
import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  BALANCE_EXCLUDED_LEDGER_TYPES,
} from "../../functions/_shared/onecabFinanceLedger.ts";
import { PAYOUT_ELIGIBLE_LEDGER_TYPES } from "../../functions/_shared/driverPayoutEligibilitySSOT.ts";
import { WALLET_BALANCE_EXCLUDED_LEDGER_TYPES } from "../../functions/_shared/walletBalanceSSOT.ts";
import {
  pendingEntitlementAmountPence,
  PENDING_ENTITLEMENT_BALANCE_EXCLUDED_TYPES,
  resolveVisibleTripEarningPence,
  TRIP_EARNING_PENDING_RELEASE_TYPE,
  TRIP_EARNING_PENDING_TYPE,
} from "./offline/tripEarningPendingSSOT.ts";
import {
  TODAY_EARNINGS_INCLUDE_TYPES,
  TODAY_EARNINGS_SETTLEMENT_CORRECTION_TYPES,
  sumTodayEarningsPence,
} from "../../functions/driver-earnings-summary/lib/todayEarningsSsot.ts";

Deno.test("#98 PENDING/RELEASE types excluded from payout eligibility", () => {
  assertEquals(PAYOUT_ELIGIBLE_LEDGER_TYPES.has(TRIP_EARNING_PENDING_TYPE), false);
  assertEquals(PAYOUT_ELIGIBLE_LEDGER_TYPES.has(TRIP_EARNING_PENDING_RELEASE_TYPE), false);
  assertEquals(PAYOUT_ELIGIBLE_LEDGER_TYPES.has("TRIP_EARNING_NET"), true);
});

Deno.test("#98 PENDING/RELEASE excluded from live wallet balance", () => {
  assertEquals(
    (BALANCE_EXCLUDED_LEDGER_TYPES as readonly string[]).includes(TRIP_EARNING_PENDING_TYPE),
    true,
  );
  assertEquals(
    (BALANCE_EXCLUDED_LEDGER_TYPES as readonly string[]).includes(TRIP_EARNING_PENDING_RELEASE_TYPE),
    true,
  );
  assertEquals(WALLET_BALANCE_EXCLUDED_LEDGER_TYPES.has(TRIP_EARNING_PENDING_TYPE), true);
  assertEquals(WALLET_BALANCE_EXCLUDED_LEDGER_TYPES.has(TRIP_EARNING_PENDING_RELEASE_TYPE), true);
  assertEquals(
    PENDING_ENTITLEMENT_BALANCE_EXCLUDED_TYPES.includes(TRIP_EARNING_PENDING_TYPE),
    true,
  );
});

Deno.test("#98 amount SSOT matches TEN (driver_net + airport)", () => {
  assertEquals(pendingEntitlementAmountPence({ driverNetPence: 425, airportChargePence: 0 }), 425);
  assertEquals(pendingEntitlementAmountPence({ driverNetPence: 425, airportChargePence: 200 }), 625);
  assertEquals(pendingEntitlementAmountPence({ driverNetPence: 0, airportChargePence: 50 }), 50);
  assertEquals(pendingEntitlementAmountPence({ driverNetPence: null, airportChargePence: null }), 0);
});

Deno.test("#98 Today includes PENDING and RELEASE nets to one economic amount", () => {
  assertEquals(TODAY_EARNINGS_INCLUDE_TYPES.includes(TRIP_EARNING_PENDING_TYPE), true);
  assertEquals(
    TODAY_EARNINGS_SETTLEMENT_CORRECTION_TYPES.includes(TRIP_EARNING_PENDING_RELEASE_TYPE),
    true,
  );

  const day = "2026-11-25T12:00:00.000Z";
  const start = "2026-11-25T00:00:00.000Z";
  const end = "2026-11-26T00:00:00.000Z";
  const pendingOnly = sumTodayEarningsPence(
    [{ type: TRIP_EARNING_PENDING_TYPE, amount_pence: 425, created_at: day }],
    start,
    end,
  );
  assertEquals(pendingOnly, 425);

  const afterConfirm = sumTodayEarningsPence(
    [
      { type: TRIP_EARNING_PENDING_TYPE, amount_pence: 425, created_at: day },
      { type: TRIP_EARNING_PENDING_RELEASE_TYPE, amount_pence: -425, created_at: day },
      { type: "TRIP_EARNING_NET", amount_pence: 425, created_at: day },
    ],
    start,
    end,
  );
  assertEquals(afterConfirm, 425);
});

Deno.test("#98 visible trip earning prefers TEN then open PENDING", () => {
  assertEquals(
    resolveVisibleTripEarningPence([
      { type: TRIP_EARNING_PENDING_TYPE, amount_pence: 425 },
    ]),
    { amountPence: 425, state: "awaiting_confirmation" },
  );
  assertEquals(
    resolveVisibleTripEarningPence([
      { type: TRIP_EARNING_PENDING_TYPE, amount_pence: 425 },
      { type: TRIP_EARNING_PENDING_RELEASE_TYPE, amount_pence: -425 },
      { type: "TRIP_EARNING_NET", amount_pence: 425 },
    ]),
    { amountPence: 425, state: "confirmed" },
  );
  assertEquals(
    resolveVisibleTripEarningPence([
      { type: TRIP_EARNING_PENDING_TYPE, amount_pence: 425 },
      { type: TRIP_EARNING_PENDING_RELEASE_TYPE, amount_pence: -425 },
    ]),
    { amountPence: 0, state: "none" },
  );
});

Deno.test("#98 stop-workflow posts PENDING; capture ledger RELEASE then TEN", async () => {
  const stop = await Deno.readTextFile(
    new URL("../../functions/stop-workflow/index.ts", import.meta.url),
  );
  assertStringIncludes(stop, "creditTripEarningPending");
  assertStringIncludes(stop, "postPendingEntitlement");
  assertStringIncludes(stop, "TRIP_EARNING_PENDING");

  const ledger = await Deno.readTextFile(
    new URL("../../functions/_shared/onecabFinanceLedger.ts", import.meta.url),
  );
  assertStringIncludes(ledger, "releaseTripEarningPendingIfPresent");
  assertStringIncludes(ledger, "PENDING_ENTITLEMENT_BALANCE_EXCLUDED_TYPES");

  const mig = await Deno.readTextFile(
    new URL("../../migrations/20270301180000_trip_earning_pending_98.sql", import.meta.url),
  );
  assertStringIncludes(mig, "credit_trip_earning_pending");
  assertStringIncludes(mig, "driver_wallet_ledger_trip_earning_pending_unique");
  assertStringIncludes(mig, "TRIP_EARNING_PENDING_RELEASE");
  assertStringIncludes(mig, "TRIP_EARNING_PENDING_AFTER_TEN_FORBIDDEN");

  // #93E — enum COALESCE fix + deploy contract must exist (MK-261126-003).
  const mig93e = await Deno.readTextFile(
    new URL(
      "../../migrations/20270301200000_fix_credit_trip_earning_pending_enum_coalesce_93e.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(mig93e, "financial_model::text");
  assertStringIncludes(mig93e, "assert_credit_trip_earning_pending_contract");
  assertStringIncludes(mig93e, "invalid_text_representation");

  const pendingSsot = await Deno.readTextFile(
    new URL("../../functions/_shared/tripEarningPendingSSOT.ts", import.meta.url),
  );
  assertStringIncludes(pendingSsot, "pending_entitlement_rpc_failed");
  assertStringIncludes(pendingSsot, "recordPaymentFinancialEvent");

  const recovery = await Deno.readTextFile(
    new URL(
      "../../functions/_shared/missingTripEarningPendingRecoverySSOT.ts",
      import.meta.url,
    ),
  );
  assertStringIncludes(recovery, "PENDING_RECOVERY_AWAITING_CAPTURE_STATUSES");
  assertStringIncludes(recovery, "missing_pending_recovery_failed");

  const sweep = await Deno.readTextFile(
    new URL("../../functions/sweep-revolut-stale-holds/index.ts", import.meta.url),
  );
  assertStringIncludes(sweep, "missing_pending_recovery_98");
  assertStringIncludes(sweep, "recoverMissingTripEarningPendingBatch");
});

Deno.test("#98 G8 preserved — no TEN before capture in tip-window path", async () => {
  const stop = await Deno.readTextFile(
    new URL("../../functions/stop-workflow/index.ts", import.meta.url),
  );
  assertStringIncludes(stop, "tip-window TEN deferred until capture confirmed");
  assertStringIncludes(stop, "never post TEN during tip-window deferral");
});

Deno.test("#98/#113 complete tip-window PENDING is fail-closed; no TipWindowTen name drift", async () => {
  const stop = await Deno.readTextFile(
    new URL("../../functions/stop-workflow/index.ts", import.meta.url),
  );
  // MK-261126-006/007: queueTipWindowTen def + voidTipWindowTen calls → ReferenceError 500.
  assertStringIncludes(stop, "logTipWindowTenDeferred");
  assertStringIncludes(stop, "PENDING_ENTITLEMENT_FAILED");
  assertStringIncludes(stop, "if (pendingFail) return pendingFail");
  assertEquals(stop.includes("Never block Complete→Rate"), false);
  assertEquals(stop.includes("Never block Complete->Rate"), false);

  const liveLines = stop.split("\n").filter((line) => {
    const t = line.trimStart();
    return !t.startsWith("//") && !t.startsWith("*");
  });
  const live = liveLines.join("\n");
  assertEquals(live.includes("voidTipWindowTen"), false);
  assertEquals(live.includes("queueTipWindowTen"), false);
  // Every tip-window / capture PENDING await must fail closed.
  assertEquals((live.match(/pendingFail/g) ?? []).length >= 8, true);
});
