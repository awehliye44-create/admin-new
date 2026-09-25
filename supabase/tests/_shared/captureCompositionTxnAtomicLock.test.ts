/**
 * Source lock: acquire must be one atomic RPC — no Edge multi-round-trip plan path.
 */
import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const ACQUIRE_PATH = new URL(
  "../../functions/_shared/captureCompositionAcquireSSOT.ts",
  import.meta.url,
);
const RPC_MIGRATION = new URL(
  "../../migrations/20260925130000_payment_session_acquire_capture_composition.sql",
  import.meta.url,
);

Deno.test("acquire source calls only payment_session_acquire_capture_composition RPC", async () => {
  const src = await Deno.readTextFile(ACQUIRE_PATH);
  assertStringIncludes(src, 'ACQUIRE_CAPTURE_COMPOSITION_RPC');
  assertStringIncludes(src, "payment_session_acquire_capture_composition");
  assertStringIncludes(src, "supabase.rpc(ACQUIRE_CAPTURE_COMPOSITION_RPC");
  // Must not reintroduce Edge multi-query plan path after lock.
  assertEquals(src.includes("loadReservedAllocations"), false);
  assertEquals(src.includes("persistFrozenPlan"), false);
  assertEquals(src.includes("planCaptureComposition("), false);
  assertEquals(src.includes("decideCaptureCompositionAction("), false);
  assertStringIncludes(src, "CAPTURE_COMPOSITION_MIGRATION_REQUIRED");
});

Deno.test("RPC migration holds advisory_xact_lock through freeze in one function body", async () => {
  const sql = await Deno.readTextFile(RPC_MIGRATION);
  assertStringIncludes(sql, "CREATE OR REPLACE FUNCTION public.payment_session_acquire_capture_composition");
  assertStringIncludes(sql, "pg_advisory_xact_lock");
  assertStringIncludes(
    sql,
    "hashtext('capture_composition:' || p_payment_session_id::text)",
  );
  assertStringIncludes(sql, "FOR UPDATE");
  assertStringIncludes(sql, "FOR UPDATE OF a");
  assertStringIncludes(sql, "capture_composition_frozen_at = v_now");
  assertStringIncludes(sql, "capture_idempotency_key = v_key");
  assertStringIncludes(sql, "AND capture_idempotency_key IS NULL");
  assertStringIncludes(sql, "kind', 'resumed'");
  assertStringIncludes(sql, "kind', 'created'");
  // Single function = single statement transaction boundary for supabase.rpc.
  const fnStarts = (sql.match(/CREATE OR REPLACE FUNCTION public\.payment_session_acquire_capture_composition/g) ?? [])
    .length;
  assertEquals(fnStarts, 1);
});

Deno.test("missing migration fails closed (constant present)", async () => {
  const src = await Deno.readTextFile(ACQUIRE_PATH);
  assertStringIncludes(src, "apply migration before capture");
  assertStringIncludes(src, "isMissingRpcError");
});
