/**
 * Edge re-export of the driver location state SSOT.
 * Keep Edge functions on this path so auto-dispatch / find-drivers share the
 * same frozen-driver derivation as the Admin frontend and the SQL functions
 * in supabase/migrations/20260910120000_driver_location_frozen_ssot.sql.
 */
export {
  computeDriverLocationState,
  DRIVER_LOCATION_THRESHOLDS,
  isDriverLocationFrozen,
  type DriverLocationState,
  type DriverLocationStateInput,
} from "../../../shared/driverLocationStateSSOT.ts";
