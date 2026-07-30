/**
 * Phase 1 — dispatch wave snapshot observability helper.
 * Writes to public.dispatch_wave_snapshot via record_dispatch_wave_snapshot RPC.
 * Never throws; safe to call from dispatch hot paths.
 */ export const DISPATCH_WAVE_SNAPSHOT_STAGES = [
  "considered",
  "eligible",
  "selected",
  "offer_inserted",
  "push_sent"
];
export function buildDispatchWaveSnapshotRpcArgs(input) {
  const round = Math.max(1, input.dispatchRound);
  return {
    p_trip_id: input.tripId,
    p_dispatch_round: round,
    p_stage: input.stage,
    p_wave_number: input.waveNumber ?? round,
    p_driver_id: input.driverId ?? null,
    p_source: input.source ?? null,
    p_ride_offer_id: input.rideOfferId ?? null,
    p_metadata: input.metadata ?? {}
  };
}
/** Pure helper for tests — validates stage is in the pipeline. */ export function isDispatchWaveSnapshotStage(value) {
  return DISPATCH_WAVE_SNAPSHOT_STAGES.includes(value);
}
/**
 * Record one wave snapshot stage. Idempotent at DB layer (ON CONFLICT DO NOTHING).
 * When auditPromises is provided, the RPC is queued like other dispatch audit writes.
 */ export async function recordDispatchWaveSnapshot(supabase, input, auditPromises) {
  try {
    const rpcCall = Promise.resolve(supabase.rpc("record_dispatch_wave_snapshot", buildDispatchWaveSnapshotRpcArgs(input))).then(({ error })=>{
      if (error) {
        console.warn("[recordDispatchWaveSnapshot] RPC failed:", input.stage, input.tripId, error);
      }
    });
    if (auditPromises) {
      auditPromises.push(rpcCall);
      return;
    }
    await rpcCall;
  } catch (err) {
    console.warn("[recordDispatchWaveSnapshot] unexpected error:", input.stage, err);
  }
}
