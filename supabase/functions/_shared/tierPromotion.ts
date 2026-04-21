import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * Automatic tier promotion based on completed trip count.
 *
 * Rules:
 *   1. Only COMPLETED trips count toward promotion.
 *   2. Tiers are evaluated in level_order. trip_target is the number of
 *      completed trips required to GRADUATE that tier (i.e. move to the next).
 *   3. Driver is assigned the HIGHEST active tier whose entry threshold they
 *      have crossed. Entry threshold for tier N = trip_target of tier N-1
 *      (Bronze entry = 0).
 *   4. Demotion is never automatic — only upgrades.
 *   5. Inactive tiers are skipped entirely.
 *
 * Returns the new tier id if a promotion happened, else null.
 */
export async function evaluateTierPromotion(
  supabase: SupabaseClient,
  driverId: string,
  completedTripCount: number,
): Promise<{ promoted: boolean; from_tier_id: string | null; to_tier_id: string | null; to_tier_name: string | null }> {
  // Load driver's current tier
  const { data: driver } = await supabase
    .from("drivers")
    .select("category_id")
    .eq("id", driverId)
    .single();

  // Load active tiers in order
  const { data: tiers, error: tiersErr } = await supabase
    .from("driver_categories")
    .select("id, name, level_order, trip_target")
    .eq("is_active", true)
    .order("level_order", { ascending: true });

  if (tiersErr || !tiers || tiers.length === 0) {
    return { promoted: false, from_tier_id: driver?.category_id ?? null, to_tier_id: null, to_tier_name: null };
  }

  // Build entry thresholds: tier[i] entry = sum of trip_target of tiers[0..i-1]?
  // No — clarification: trip_target is the cumulative target to REACH next tier.
  // Bronze trip_target=20 means at 20 completed trips you graduate to Silver.
  // So entry threshold for tier at index i = tiers[i-1].trip_target (cumulative),
  // and tier at index 0 (Bronze) entry = 0.
  let targetTier = tiers[0];
  for (let i = 1; i < tiers.length; i++) {
    const previousTarget = tiers[i - 1].trip_target ?? null;
    if (previousTarget == null) break; // tier with no target acts as a ceiling
    if (completedTripCount >= previousTarget) {
      targetTier = tiers[i];
    } else {
      break;
    }
  }

  const currentTierId = driver?.category_id ?? null;
  const currentTier = currentTierId ? tiers.find(t => t.id === currentTierId) : null;
  const currentLevel = currentTier?.level_order ?? 0;

  // Only upgrade — never demote
  if (targetTier.level_order <= currentLevel) {
    return { promoted: false, from_tier_id: currentTierId, to_tier_id: currentTierId, to_tier_name: currentTier?.name ?? null };
  }

  // Apply the promotion
  const { error: updErr } = await supabase
    .from("drivers")
    .update({ category_id: targetTier.id })
    .eq("id", driverId);

  if (updErr) {
    console.error("[tier-promotion] Failed to update driver tier:", updErr);
    return { promoted: false, from_tier_id: currentTierId, to_tier_id: null, to_tier_name: null };
  }

  // Audit trail
  await supabase.from("admin_audit_log").insert({
    action: "driver_tier_auto_promotion",
    target_type: "driver",
    target_id: driverId,
    details: {
      from_tier_id: currentTierId,
      from_tier_name: currentTier?.name ?? null,
      to_tier_id: targetTier.id,
      to_tier_name: targetTier.name,
      completed_trip_count: completedTripCount,
      trigger: "complete-trip",
    },
  }).then(({ error }) => {
    if (error) console.warn("[tier-promotion] audit log insert failed (non-fatal):", error.message);
  });

  return { promoted: true, from_tier_id: currentTierId, to_tier_id: targetTier.id, to_tier_name: targetTier.name };
}
