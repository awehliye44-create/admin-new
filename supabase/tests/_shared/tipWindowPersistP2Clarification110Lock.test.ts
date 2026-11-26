/**
 * #110 P3 — Clarify P2 tip-window optimisation scope.
 * P2 does NOT remove the settlement trips UPDATE; it only omits tip_window_*
 * columns when the completion stamp is verified. Full UPDATE elimination is
 * the atomic RPC (still STOP BEFORE PROD).
 *
 * Run: deno test --allow-read supabase/tests/_shared/tipWindowPersistP2Clarification110Lock.test.ts
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

Deno.test("P2 skips tip_window columns but still UPDATEs settlement", async () => {
  const stop = await Deno.readTextFile(
    new URL("../../functions/stop-workflow/index.ts", import.meta.url),
  );
  assertStringIncludes(stop, "skipTipWindowColumns");
  assertStringIncludes(stop, "buildTipWindowSettlementUpdate");
  assertStringIncludes(stop, "tip_window_verified_settlement_only");
  // Settlement write remains (not an entire UPDATE removal).
  assertStringIncludes(stop, ".update(tipSettlementPatch)");
  assertEquals(stop.includes("complete_trip_atomic_v1"), false);
});

Deno.test("atomic RPC remains draft-only under _draft_review_only", async () => {
  const draft = await Deno.readTextFile(
    new URL(
      "../../migrations/_draft_review_only/DRAFT_complete_trip_atomic_v1.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(draft, "STOP BEFORE PROD");
  assertStringIncludes(draft, "complete_trip_atomic_v1");
});
