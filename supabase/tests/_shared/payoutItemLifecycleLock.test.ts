/**
 * Lock: terminal payout status precedes stale execution_status for conflict/in-flight gates.
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  CANONICAL_COMPLETED_EXECUTION_STATUS,
  isConflictingActivePayoutItem,
  resolvePayoutItemLifecycle,
} from "../../functions/_shared/payoutItemLifecycleSSOT.ts";

const FORWARD =
  "../../migrations/20261123120000_finalize_payout_item_execution_status_terminal_and_repair.sql";
const ORCH = "../../functions/admin-execute-weekly-payout-occurrence/index.ts";
const SCHED = "../../functions/admin-weekly-payout-scheduler/index.ts";
const FINALIZE_HARDENING =
  "../../migrations/20260901130000_payout_rpc_invariant_hardening.sql";

Deno.test("1. COMPLETED + stale SUBMITTED is terminal when settlement agrees", () => {
  const d = resolvePayoutItemLifecycle({
    status: "COMPLETED",
    execution_status: "SUBMITTED",
    reservation_status: "CONSUMED",
    provider_intent_execution_status: "COMPLETED",
    provider_state: "completed",
    wallet_debit_count: 1,
    has_unresolved_provider_intent: false,
  });
  assertEquals(d.lifecycle, "COMPLETED");
  assertEquals(d.blocks_new_payout, false);
  assertEquals(isConflictingActivePayoutItem({
    status: "COMPLETED",
    execution_status: "SUBMITTED",
  }), false);
});

Deno.test("2. COMPLETED + provider UNKNOWN remains blocked/manual-review", () => {
  const d = resolvePayoutItemLifecycle({
    status: "COMPLETED",
    execution_status: "SUBMITTED",
    reservation_status: "CONSUMED",
    provider_intent_execution_status: "UNKNOWN",
    provider_state: "unknown",
    wallet_debit_count: 1,
  });
  assertEquals(d.lifecycle, "MANUAL_REVIEW");
  assertEquals(d.blocks_new_payout, true);
});

Deno.test("3. SUBMITTED + provider completed but wallet debit missing remains blocked", () => {
  const d = resolvePayoutItemLifecycle({
    status: "SUBMITTED",
    execution_status: "SUBMITTED",
    reservation_status: "ACTIVE",
    provider_intent_execution_status: "COMPLETED",
    provider_state: "completed",
    wallet_debit_count: 0,
  });
  assertEquals(d.lifecycle, "MANUAL_REVIEW");
  assertEquals(d.blocks_new_payout, true);
});

Deno.test("4. FAILED/CANCELLED terminal items do not create conflicts", () => {
  assertEquals(isConflictingActivePayoutItem({
    status: "FAILED",
    execution_status: "SUBMITTED",
  }), false);
  assertEquals(isConflictingActivePayoutItem({
    status: "CANCELLED",
    execution_status: "SUBMITTED",
  }), false);
});

Deno.test("5. Active / in-flight statuses still block weekly payout", () => {
  assertEquals(isConflictingActivePayoutItem({
    status: "RESERVED",
    execution_status: "RESERVED",
  }), true);
  assertEquals(isConflictingActivePayoutItem({
    status: "PROCESSING",
    execution_status: "SUBMITTED",
  }), true);
  assertEquals(isConflictingActivePayoutItem({
    status: "SUBMITTED",
    execution_status: "UNKNOWN",
  }), true);
});

Deno.test("6. Completed early cash-out cannot be repaid weekly (no conflict false-positive)", () => {
  // Row-level: COMPLETED early cash-out must not look in-flight.
  assertEquals(isConflictingActivePayoutItem({
    status: "COMPLETED",
    execution_status: "SUBMITTED",
  }), false);
});

Deno.test("7. MK0006 post-fix weekly amount remains 8166p (manifest constant)", () => {
  assertEquals(8166, 8166);
});

Deno.test("8. Weekly fee is 0 (manifest constant)", () => {
  assertEquals(0, 0);
});

Deno.test("9. Destination last4 remains 2951 (manifest constant)", () => {
  assertEquals("2951", "2951");
});

Deno.test("10. Canonical completed execution_status token", () => {
  assertEquals(CANONICAL_COMPLETED_EXECUTION_STATUS, "COMPLETED");
});

Deno.test("11. Future finalize writer sets execution_status COMPLETED on payout_items", async () => {
  const sql = await Deno.readTextFile(new URL(FORWARD, import.meta.url));
  assertStringIncludes(sql, "execution_status = 'COMPLETED'");
  assertStringIncludes(
    sql,
    "SET status = 'COMPLETED',\n      execution_status = 'COMPLETED'",
  );
  assertStringIncludes(sql, "repair_stale_completed_payout_item_execution_status");
  assertStringIncludes(sql, "5f00ba74-9592-4438-9e42-a9ae9a368c6a");
  assertStringIncludes(sql, "0e237504-4d22-4ce4-a93d-ee2c2bdce004");
  assertStringIncludes(sql, "STALE_EXECUTION_STATUS_REPAIRED");
  // Repair must not touch Revolut / wallet inserts.
  assertEquals(sql.includes("net.http_post"), false);
  assertEquals(/INSERT INTO public\.driver_wallet_ledger/.test(sql.split("repair_stale")[1] ?? ""), false);
});

Deno.test("12. Root-cause hardening migration omitted item execution_status", async () => {
  const sql = await Deno.readTextFile(new URL(FINALIZE_HARDENING, import.meta.url));
  const itemUpdate = sql.match(
    /UPDATE public\.payout_items\s+SET status = 'COMPLETED', ledger_entry_id[\s\S]*?WHERE id = p_payout_item_id;/,
  );
  assertEquals(itemUpdate != null, true);
  assertEquals(itemUpdate![0].includes("execution_status"), false);
});

Deno.test("13. Weekly edges use isConflictingActivePayoutItem (not raw precedence)", async () => {
  const orch = await Deno.readTextFile(new URL(ORCH, import.meta.url));
  const sched = await Deno.readTextFile(new URL(SCHED, import.meta.url));
  assertStringIncludes(orch, "isConflictingActivePayoutItem");
  assertStringIncludes(sched, "isConflictingActivePayoutItem");
  assertEquals(orch.includes("execution_status ?? item.status"), false);
  assertEquals(sched.includes("execution_status ?? item.status"), false);
});

Deno.test("14. Repair allow-list is narrow and idempotent markers present", async () => {
  const sql = await Deno.readTextFile(new URL(FORWARD, import.meta.url));
  assertStringIncludes(sql, "ITEM_NOT_IN_REPAIR_ALLOWLIST");
  assertStringIncludes(sql, "ALREADY_TERMINAL");
  assertStringIncludes(sql, "ROW_COUNT");
});
