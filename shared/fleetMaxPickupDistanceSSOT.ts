/**
 * Single source of truth lives under supabase/functions/_shared (bundled with edge deploys).
 * Re-exported here for frontend/test imports.
 */
export * from "../supabase/functions/_shared/fleetMaxPickupDistanceSSOT.ts";
export * from "./edgePresentation/fleetMaxPickupDistanceSSOT.ts";
