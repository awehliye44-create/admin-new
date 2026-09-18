import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ALLOWLIST_VIOLATION,
  APPROVED_TOTAL_PENCE,
  EXCLUDED_PENDING_MK008_TRIP_ID,
  FIVE_HISTORICAL_MISSING_TEN_ALLOWLIST,
  FIVE_HISTORICAL_MISSING_TEN_IDS,
  gateExactFiveTripAllowlist,
  isLiveExecutionRequest,
  LIVE_EXECUTION_DISABLED,
} from "./fiveHistoricalMissingTenDryRunSSOT.ts";

Deno.test("exact five allow-list IDs and total 2629p", () => {
  assertEquals(FIVE_HISTORICAL_MISSING_TEN_IDS.length, 5);
  assertEquals(APPROVED_TOTAL_PENCE, 2629);
  const sum = Object.values(FIVE_HISTORICAL_MISSING_TEN_ALLOWLIST).reduce(
    (s, r) => s + r.approved_amount_pence,
    0,
  );
  assertEquals(sum, 2629);
  assertEquals(
    FIVE_HISTORICAL_MISSING_TEN_ALLOWLIST["ddc88920-1da3-4d2f-a85c-8de61a62d692"].approved_amount_pence,
    425,
  );
  assertEquals(
    FIVE_HISTORICAL_MISSING_TEN_ALLOWLIST["49883300-872b-42e5-917b-542f9deaf772"].approved_amount_pence,
    382,
  );
  assertEquals(
    FIVE_HISTORICAL_MISSING_TEN_ALLOWLIST["e594e764-c108-4b67-8a6e-80934019df2f"].approved_amount_pence,
    670,
  );
  assertEquals(
    FIVE_HISTORICAL_MISSING_TEN_ALLOWLIST["32315218-b0b3-44d2-bf4c-cfa7c5619acc"].approved_amount_pence,
    744,
  );
  assertEquals(
    FIVE_HISTORICAL_MISSING_TEN_ALLOWLIST["229223e3-c100-495d-afd8-2c39a3acf6b2"].approved_amount_pence,
    408,
  );
});

Deno.test("gate accepts exact five in any order", () => {
  const shuffled = [...FIVE_HISTORICAL_MISSING_TEN_IDS].reverse();
  const g = gateExactFiveTripAllowlist(shuffled);
  assertEquals(g.ok, true);
  if (g.ok) assertEquals(g.trip_ids.length, 5);
});

Deno.test("MK-008 → allow-list violation", () => {
  const ids = [...FIVE_HISTORICAL_MISSING_TEN_IDS];
  ids[0] = EXCLUDED_PENDING_MK008_TRIP_ID;
  const g = gateExactFiveTripAllowlist(ids);
  assertEquals(g.ok, false);
  if (!g.ok) {
    assertEquals(g.error, ALLOWLIST_VIOLATION);
    assertStringIncludes(g.message, "PENDING_EVIDENCE");
  }
});

Deno.test("unknown / additional / missing / duplicate / mixed IDs blocked", () => {
  assertEquals(gateExactFiveTripAllowlist([...FIVE_HISTORICAL_MISSING_TEN_IDS, "00000000-0000-0000-0000-000000000099"]).ok, false);
  assertEquals(gateExactFiveTripAllowlist(FIVE_HISTORICAL_MISSING_TEN_IDS.slice(0, 4)).ok, false);
  assertEquals(
    gateExactFiveTripAllowlist([
      ...FIVE_HISTORICAL_MISSING_TEN_IDS.slice(0, 4),
      FIVE_HISTORICAL_MISSING_TEN_IDS[0],
    ]).ok,
    false,
  );
  assertEquals(
    gateExactFiveTripAllowlist([
      ...FIVE_HISTORICAL_MISSING_TEN_IDS.slice(0, 4),
      "00000000-0000-0000-0000-000000000001",
    ]).ok,
    false,
  );
  assertEquals(gateExactFiveTripAllowlist(null).ok, false);
});

Deno.test("dry_run:false and confirm flags → live execution request", () => {
  assertEquals(isLiveExecutionRequest({ dry_run: false }), true);
  assertEquals(isLiveExecutionRequest({ dry_run: true, confirm: "x" }), true);
  assertEquals(isLiveExecutionRequest({ dry_run: true, insert_ten: true }), true);
  assertEquals(isLiveExecutionRequest({ dry_run: true, mode: "execute" }), true);
  assertEquals(isLiveExecutionRequest({ dry_run: true }), false);
});

Deno.test("handler source: LIVE_EXECUTION_DISABLED; no money/provider writers", async () => {
  const src = await Deno.readTextFile(
    new URL("../admin-recover-five-historical-missing-ten/index.ts", import.meta.url),
  );
  assertStringIncludes(src, LIVE_EXECUTION_DISABLED);
  assertStringIncludes(src, "dry_run");
  assertStringIncludes(src, "requireSuperAdminOrServiceRole");
  assertEquals(src.includes("insert_ten"), false); // no executable branch name beyond reject
  assertEquals(src.includes('from("driver_wallet_ledger").insert'), false);
  assertEquals(src.includes("creditCapturedCardTripLedger"), false);
  assertEquals(src.includes("applyCanonicalSettlementAfterCapture"), false);
  assertEquals(src.includes("refundRevolutOrder"), false);
  assertEquals(src.includes("retrieveRevolutOrder"), false);
  assertEquals(src.includes("financial_ssot_repairs"), false);
  assertEquals(src.includes("MK-260817-007"), false);
  assertEquals(src.includes("MK-007"), false);
  assertEquals(src.includes("MK-009"), false);
});

Deno.test("SSOT source: no ledger DML / no provider / economic from captured_at", async () => {
  const src = await Deno.readTextFile(new URL("./fiveHistoricalMissingTenDryRunSSOT.ts", import.meta.url));
  assertEquals(src.includes('from("driver_wallet_ledger").insert'), false);
  assertEquals(src.includes(".upsert("), false);
  assertEquals(src.includes('from("payment_sessions").update'), false);
  assertEquals(src.includes('from("trips").update'), false);
  assertEquals(src.includes("fetch("), false);
  assertEquals(src.includes("revolut"), false);
  assertStringIncludes(src, "economic_earned_at");
  assertStringIncludes(src, "captured_at");
  assertStringIncludes(src, "posting_created_at: null");
  assertStringIncludes(src, "CANONICAL_CAPTURED_AT");
  assertEquals(/0\.85|Math\.round\([^)]*\*\s*0\./.test(src), false);
  assertEquals(src.includes("limit(1)"), false);
  assertEquals(src.includes("MK-260817-007"), false);
});

Deno.test("existing TEN / CW / wrong model paths are coded fail-closed", async () => {
  const src = await Deno.readTextFile(new URL("./fiveHistoricalMissingTenDryRunSSOT.ts", import.meta.url));
  assertStringIncludes(src, "existing TEN");
  assertStringIncludes(src, "Commission Wallet");
  assertStringIncludes(src, "PLATFORM_COLLECTED");
  assertStringIncludes(src, "multiple RIDE_BOOKING");
  assertStringIncludes(src, "zero RIDE_BOOKING");
  assertStringIncludes(src, "sessionLooksCaptured");
  assertStringIncludes(src, "sessionIsTerminalNonCapture");
});
