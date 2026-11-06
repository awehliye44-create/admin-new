/**
 * MK-261106-007: scheduled→instant convert must not strand dispatch after
 * VERSION_MISMATCH / OFFER_CREATE_UNIQUE_COLLISION. Resume while search TTL
 * remains; honour Admin max 9 sequences; never wave after terminal.
 *
 * Run:
 *   deno test --no-check --allow-read supabase/tests/_shared/mk261106007DispatchResumeLock.test.ts
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  maxBroadcastRoundFromOfferRows,
  resolveConversionBroadcastRoundAnchor,
  resolveUniqueDispatchBroadcastRound,
} from "../../functions/_shared/dispatchBroadcastRoundAllocation.ts";
import { buildScheduledUrgentConversionPatch } from "../../functions/_shared/scheduledDispatchConfig.ts";
import {
  DISPATCH_STATUS_OFFER_CREATE_BLOCKED,
  isRideOfferBroadcastRoundUniqueViolation,
  isStaleTripRebroadcastCandidate,
  OFFER_CREATE_UNIQUE_COLLISION_REASON,
} from "../../functions/_shared/sweepExpiredOffers.ts";
import {
  effectiveBroadcastRoundForResume,
  isCommitDispatchWaveVersionMismatch,
  shouldBlockDispatchResumeForTripStatus,
  tripPatchAfterTransientOfferCreateFailure,
} from "../../functions/_shared/dispatchWaveCommitResumeSSOT.ts";

const DRIVER_A = "c40dd8a6-f422-40bc-9534-bae7be88b93e";
const DRIVER_B = "56136f5f-1a3a-4a14-bb23-439b3951415a";

Deno.test("conversion during scheduled marketplace: unique post-convert seq with history 1–4", () => {
  const offers = [
    { broadcast_round: 1 },
    { broadcast_round: 1 },
    { broadcast_round: 2 },
    { broadcast_round: 3 },
    { broadcast_round: 4 },
    { broadcast_round: 4 },
  ];
  const maxExisting = maxBroadcastRoundFromOfferRows(offers);
  assertEquals(maxExisting, 4);
  const patch = buildScheduledUrgentConversionPatch({
    nowIso: "2026-11-06T11:26:01.000Z",
    searchingExpiresAtIso: "2026-11-06T11:32:00.000Z",
    maxExistingBroadcastRound: maxExisting,
    maxBroadcastSequences: 9,
  });
  assertEquals(patch.dispatch_mode, "instant");
  assertEquals(patch.scheduled_status, "converted_to_instant");
  assertEquals(patch.current_broadcast_round, 6);
  assertEquals(patch.max_broadcast_rounds >= 9, true);

  // Stranded stamp 0 (audit) must still allocate unique seq via offer history.
  const stranded = resolveUniqueDispatchBroadcastRound({
    storedRound: 0,
    maxExistingOfferRound: maxExisting,
    maxRounds: 9,
    forceRebroadcast: true,
    searchWindowActive: true,
  });
  assertEquals(stranded, 7);
  assertEquals(stranded, resolveConversionBroadcastRoundAnchor(maxExisting) + 1);
});

Deno.test("concurrent VERSION_MISMATCH is detected as recoverable", () => {
  assertEquals(isCommitDispatchWaveVersionMismatch("VERSION_MISMATCH"), true);
  assertEquals(
    isCommitDispatchWaveVersionMismatch({ error: "VERSION_MISMATCH", current_version: 3 }),
    true,
  );
  assertEquals(isCommitDispatchWaveVersionMismatch("DB_ERROR"), false);
});

Deno.test("OFFER_CREATE_UNIQUE_COLLISION stamps recoverable broadcasting round — not permanent block", () => {
  assertEquals(
    isRideOfferBroadcastRoundUniqueViolation(
      'duplicate key value violates unique constraint "ride_offers_trip_id_driver_id_broadcast_round_key"',
    ),
    true,
  );
  const patch = tripPatchAfterTransientOfferCreateFailure({
    nowIso: "2026-11-06T11:26:05.000Z",
    storedRound: 0,
    maxExistingOfferRound: 4,
    attemptedBroadcastRound: 7,
  });
  assertEquals(patch.dispatch_status, "broadcasting");
  assertEquals(patch.broadcast_enabled, true);
  assertEquals(patch.current_broadcast_round, 7);
  assertEquals(patch.dispatch_status === DISPATCH_STATUS_OFFER_CREATE_BLOCKED, false);

  // Next unique sequence after stamped 7 with history max 4 → 8
  const next = resolveUniqueDispatchBroadcastRound({
    storedRound: patch.current_broadcast_round,
    maxExistingOfferRound: 4,
    maxRounds: 9,
    forceRebroadcast: true,
    searchWindowActive: true,
  });
  assertEquals(next, 8);
});

Deno.test("retry/resume after failed offer insert: stale candidate with round=0 + history", () => {
  const now = Date.parse("2026-11-06T11:27:00.000Z");
  assertEquals(
    isStaleTripRebroadcastCandidate({
      dispatch_status: "broadcasting",
      current_broadcast_round: 0,
      max_broadcast_rounds: 9,
      pending_offer_count: 0,
      max_existing_offer_round: 4,
      searching_expires_at: "2026-11-06T11:32:00.000Z",
      nowMs: now,
    }),
    true,
  );
  // Legacy permanent block status is also resumable while TTL live.
  assertEquals(
    isStaleTripRebroadcastCandidate({
      dispatch_status: DISPATCH_STATUS_OFFER_CREATE_BLOCKED,
      current_broadcast_round: 4,
      max_broadcast_rounds: 9,
      pending_offer_count: 0,
      max_existing_offer_round: 4,
      searching_expires_at: "2026-11-06T11:32:00.000Z",
      nowMs: now,
    }),
    true,
  );
  // Pending offers → no rebroadcast (no duplicate active offers).
  assertEquals(
    isStaleTripRebroadcastCandidate({
      dispatch_status: "broadcasting",
      current_broadcast_round: 4,
      max_broadcast_rounds: 9,
      pending_offer_count: 2,
      max_existing_offer_round: 4,
      searching_expires_at: "2026-11-06T11:32:00.000Z",
      nowMs: now,
    }),
    false,
  );
});

Deno.test("no waves after assignment / cancel / terminal / expiry", () => {
  for (const status of [
    "accepted",
    "driver_assigned",
    "cancelled",
    "customer_cancelled",
    "expired",
    "expired_no_driver",
    "completed",
    "in_progress",
  ]) {
    assertEquals(shouldBlockDispatchResumeForTripStatus(status), true, status);
  }
  assertEquals(shouldBlockDispatchResumeForTripStatus("searching"), false);

  const afterExpiry = Date.parse("2026-11-06T11:32:01.000Z");
  assertEquals(
    isStaleTripRebroadcastCandidate({
      dispatch_status: "broadcasting",
      current_broadcast_round: 4,
      max_broadcast_rounds: 9,
      pending_offer_count: 0,
      max_existing_offer_round: 4,
      searching_expires_at: "2026-11-06T11:32:00.000Z",
      nowMs: afterExpiry,
    }),
    false,
  );
});

Deno.test("configured maximum of 9 sequences stops stale resume", () => {
  assertEquals(
    isStaleTripRebroadcastCandidate({
      dispatch_status: "broadcasting",
      current_broadcast_round: 9,
      max_broadcast_rounds: 9,
      pending_offer_count: 0,
      max_existing_offer_round: 9,
      searching_expires_at: "2026-11-06T11:32:00.000Z",
      nowMs: Date.parse("2026-11-06T11:27:00.000Z"),
    }),
    false,
  );
  // While TTL live, allocator may still go past 9 — but stale scan must not
  // keep force-rebroadcasting at/after the configured stamp.
  assertEquals(
    effectiveBroadcastRoundForResume({
      storedRound: 9,
      maxExistingOfferRound: 9,
      attemptedBroadcastRound: 7,
    }),
    9,
  );
});

Deno.test("source lock: auto-dispatch recovers collision; expire-offers resumes blocked", async () => {
  const autoDispatch = await Deno.readTextFile(
    new URL("../../functions/auto-dispatch/index.ts", import.meta.url),
  );
  assertStringIncludes(autoDispatch, "tripPatchAfterTransientOfferCreateFailure");
  assertStringIncludes(autoDispatch, "broadcast_round_healed_from_offer_history");
  assertStringIncludes(autoDispatch, "isCommitDispatchWaveVersionMismatch");
  assertEquals(autoDispatch.includes("tripPatchAfterPermanentOfferCreateError"), false);

  const expire = await Deno.readTextFile(
    new URL("../../functions/expire-offers/index.ts", import.meta.url),
  );
  assertStringIncludes(expire, "offer_create_blocked");
  assertStringIncludes(expire, "max_existing_offer_round");
  assertStringIncludes(expire, "searching_expires_at");

  const migration = await Deno.readTextFile(
    new URL(
      "../../migrations/20261106120000_commit_dispatch_wave_honour_broadcast_round.sql",
      import.meta.url,
    ),
  );
  assertStringIncludes(migration, "broadcast_round");
  assertStringIncludes(migration, "MK-261106-007");
  assert(
    migration.includes("COALESCE(r.broadcast_round, v_new_round)")
      || migration.includes("NULLIF((x->>'broadcast_round')"),
  );

  assertEquals(OFFER_CREATE_UNIQUE_COLLISION_REASON, "OFFER_CREATE_UNIQUE_COLLISION");
  // drivers referenced for audit fidelity
  assertEquals(typeof DRIVER_A, "string");
  assertEquals(typeof DRIVER_B, "string");
});
