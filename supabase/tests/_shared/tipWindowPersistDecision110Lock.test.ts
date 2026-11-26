/**
 * #110 P2 — Tip-window persist skip lock.
 * Run: deno test --allow-read supabase/tests/_shared/tipWindowPersistDecision110Lock.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildTipWindowSettlementUpdate,
  isAuthoritativeTipWindowPersisted,
} from "../../functions/_shared/tipWindowPersistDecisionSSOT.ts";
import { TIP_WINDOW_STATUS } from "../../functions/_shared/tipWindowConstants.ts";

const OPENED = "2026-11-26T12:00:00.000Z";
const EXPIRES = "2026-11-26T12:20:00.000Z";
const EXPECTED = {
  tip_window_opened_at: OPENED,
  tip_window_expires_at: EXPIRES,
  tip_window_status: TIP_WINDOW_STATUS.OPEN,
  tip_window_closed_at: null as null,
};

Deno.test("verified open window matches exact completion stamps", () => {
  assertEquals(
    isAuthoritativeTipWindowPersisted({
      expected: EXPECTED,
      persisted: { ...EXPECTED },
    }),
    true,
  );
});

Deno.test("missing/inconsistent/closed stamps require recovery re-stamp", () => {
  assertEquals(
    isAuthoritativeTipWindowPersisted({ expected: EXPECTED, persisted: null }),
    false,
  );
  assertEquals(
    isAuthoritativeTipWindowPersisted({
      expected: EXPECTED,
      persisted: { ...EXPECTED, tip_window_expires_at: "2026-11-26T12:30:00.000Z" },
    }),
    false,
  );
  assertEquals(
    isAuthoritativeTipWindowPersisted({
      expected: EXPECTED,
      persisted: { ...EXPECTED, tip_window_closed_at: OPENED },
    }),
    false,
  );
  assertEquals(
    isAuthoritativeTipWindowPersisted({
      expected: EXPECTED,
      persisted: { ...EXPECTED, tip_window_status: TIP_WINDOW_STATUS.CLOSED },
    }),
    false,
  );
});

Deno.test("skip tip columns preserves settlement and omits tip_window_*", () => {
  const skipped = buildTipWindowSettlementUpdate({
    settlementColumns: { driver_net_pence: 500, commission_pence: 100 },
    tipAmountPence: 0,
    finalFarePence: 600,
    finalCustomerFarePence: 600,
    completedAtIso: OPENED,
    expiresAtIso: EXPIRES,
    skipTipWindowColumns: true,
    updatedAtIso: OPENED,
  });
  assertEquals("tip_window_opened_at" in skipped, false);
  assertEquals("tip_window_expires_at" in skipped, false);
  assertEquals(skipped.driver_net_pence, 500);
  assertEquals(skipped.final_fare_pence, 600);

  const recovery = buildTipWindowSettlementUpdate({
    settlementColumns: { driver_net_pence: 500 },
    tipAmountPence: 0,
    finalFarePence: 600,
    finalCustomerFarePence: 600,
    completedAtIso: OPENED,
    expiresAtIso: EXPIRES,
    skipTipWindowColumns: false,
    updatedAtIso: OPENED,
  });
  assertEquals(recovery.tip_window_opened_at, OPENED);
  assertEquals(recovery.tip_window_expires_at, EXPIRES);
  assertEquals(recovery.tip_window_status, TIP_WINDOW_STATUS.OPEN);
  assertEquals(recovery.tip_window_closed_at, null);
});

Deno.test("stop-workflow uses verify-then-skip tip columns and awaits PENDING", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/stop-workflow/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "isAuthoritativeTipWindowPersisted");
  assertStringIncludes(src, "buildTipWindowSettlementUpdate");
  assertStringIncludes(src, "skipTipWindowColumns");
  assertStringIncludes(src, "tip_window_verified_settlement_only");
  assertStringIncludes(src, "await postPendingEntitlement");
  // Must not blindly re-stamp tip window without verify.
  assertEquals(src.includes("do not remove yet"), false);
});
