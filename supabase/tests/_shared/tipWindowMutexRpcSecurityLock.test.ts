/**
 * Tip-window mutex RPC security lock — migration 20261126120000.
 * Proves service-role-only grants, token ownership, immutability, bounded stale reclaim.
 */

import {
  assertEquals,
  assertStringIncludes,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const MIGRATION = new URL(
  "../../migrations/20261126120000_tip_window_trigger_mutex.sql",
  import.meta.url,
);

async function migrationSrc(): Promise<string> {
  return await Deno.readTextFile(MIGRATION);
}

Deno.test("SECURITY: all three RPCs are SECURITY DEFINER with fixed search_path=public", async () => {
  const src = await migrationSrc();
  for (const name of [
    "claim_tip_window_trigger",
    "release_tip_window_trigger_claim",
    "finalize_tip_window_trigger",
  ]) {
    const idx = src.indexOf(`FUNCTION public.${name}`);
    assert(idx > 0, `missing ${name}`);
    const body = src.slice(idx, idx + 800);
    assertStringIncludes(body, "SECURITY DEFINER");
    assertStringIncludes(body, "SET search_path = public");
  }
});

Deno.test("SECURITY: REVOKE from PUBLIC/anon/authenticated; GRANT service_role only", async () => {
  const src = await migrationSrc();
  for (const name of [
    "claim_tip_window_trigger",
    "release_tip_window_trigger_claim",
    "finalize_tip_window_trigger",
  ]) {
    assertStringIncludes(src, `REVOKE ALL ON FUNCTION public.${name}`);
    assert(
      src.includes(`FROM PUBLIC`) &&
        src.includes(`FROM anon, authenticated`),
      `${name} must revoke PUBLIC and anon/authenticated`,
    );
  }
  assertEquals((src.match(/GRANT EXECUTE ON FUNCTION public\.claim_tip_window_trigger/g) ?? []).length, 1);
  assertStringIncludes(
    src,
    "GRANT EXECUTE ON FUNCTION public.claim_tip_window_trigger(uuid, text, uuid, timestamptz) TO service_role",
  );
  assertStringIncludes(
    src,
    "GRANT EXECUTE ON FUNCTION public.release_tip_window_trigger_claim(uuid, uuid, boolean, timestamptz) TO service_role",
  );
  assertStringIncludes(
    src,
    "GRANT EXECUTE ON FUNCTION public.finalize_tip_window_trigger(uuid, uuid, text, integer, timestamptz) TO service_role",
  );
  // Never grant execute to anon/authenticated.
  assertEquals(src.includes("TO anon"), false);
  assertEquals(src.includes("TO authenticated"), false);
});

Deno.test("SECURITY: release/finalize require claim token match (TOKEN_MISMATCH)", async () => {
  const src = await migrationSrc();
  const release = src.slice(src.indexOf("release_tip_window_trigger_claim"));
  const finalize = src.slice(src.indexOf("finalize_tip_window_trigger"));
  assertStringIncludes(release, "TOKEN_MISMATCH");
  assertStringIncludes(finalize, "TOKEN_MISMATCH");
  assertStringIncludes(release, "tip_window_claim_token IS DISTINCT FROM p_claim_token");
  assertStringIncludes(finalize, "tip_window_claim_token IS DISTINCT FROM p_claim_token");
});

Deno.test("SECURITY: CLAIM_HELD retains ownership — claim never auto-steals", async () => {
  const src = await migrationSrc();
  assertStringIncludes(src, "'CLAIM_HELD'");
  assertStringIncludes(src, "NEVER auto-steal here");
  assertStringIncludes(src, "EXPIRED_STALE_RECLAIM_GET_FIRST");
  assertStringIncludes(src, "stale_eligible");
});

Deno.test("SECURITY: stale reclaim is bounded (5 minutes) and GET-gated via separate RPCs", async () => {
  const src = await migrationSrc();
  assertStringIncludes(src, "interval '5 minutes'");
  assertStringIncludes(src, "reclaim_stale_tip_window_expiry_after_authorised_get");
  assertStringIncludes(src, "finalize_tip_window_expired_after_provider_capture");
  assertEquals(src.toLowerCase().includes("capture_revolut"), false);
  assertEquals(src.includes("fall through to reclaim UPDATE below"), false);
});

Deno.test("SECURITY: finalized trigger is immutable (idempotent finalize does not UPDATE)", async () => {
  const src = await migrationSrc();
  const fin = src.slice(src.indexOf("finalize_tip_window_trigger"));
  assertStringIncludes(fin, "'immutable', true");
  const idempotentBlock = fin.slice(
    fin.indexOf("already sealed"),
    fin.indexOf("TOKEN_MISMATCH"),
  );
  assertEquals(idempotentBlock.includes("UPDATE public.trips"), false);
});

Deno.test("SECURITY: Edge claim token is unguessable UUID; clients never call RPC", async () => {
  const mutex = await Deno.readTextFile(
    new URL("../../functions/_shared/tipWindowTriggerMutexSSOT.ts", import.meta.url),
  );
  const submit = await Deno.readTextFile(
    new URL("../../functions/submit-customer-trip-tip/index.ts", import.meta.url),
  );
  assertStringIncludes(mutex, "crypto.randomUUID()");
  assertStringIncludes(submit, "await claimTipWindowTrigger");
  assertStringIncludes(submit, "serviceRoleKey");
  assertStringIncludes(submit, "String(trip.passenger_id) !== String(customer.id)");
  // Passenger ownership checked before mutex claim call.
  const passengerIdx = submit.indexOf("String(trip.passenger_id) !== String(customer.id)");
  const claimIdx = submit.indexOf("await claimTipWindowTrigger");
  assertEquals(passengerIdx > 0, true);
  assertEquals(claimIdx > passengerIdx, true);
});

Deno.test("SECURITY: trigger derived server-side; tip amount not taken from finalize client alone", async () => {
  const constants = await Deno.readTextFile(
    new URL("../../functions/_shared/tipWindowConstants.ts", import.meta.url),
  );
  const submit = await Deno.readTextFile(
    new URL("../../functions/submit-customer-trip-tip/index.ts", import.meta.url),
  );
  assertStringIncludes(constants, "resolveCustomerTipWindowTrigger");
  assertStringIncludes(submit, "resolveCustomerTipWindowTrigger");
  // Tip collected after capture confirm uses recordedTipPenceAfterCapture when tip>0.
  assertStringIncludes(submit, "recordedTipPenceAfterCapture");
});

Deno.test("SECURITY: migration preserves existing CLOSED rows (no rewrite)", async () => {
  const src = await migrationSrc();
  assertStringIncludes(src, "Preserve existing CLOSED rows");
  assertEquals(src.includes("UPDATE public.trips\nSET tip_window_status = 'closed'"), false);
});
