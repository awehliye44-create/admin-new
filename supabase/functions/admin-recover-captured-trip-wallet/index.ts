/**
 * Dedicated Admin recovery for verified captured trips missing TRIP_EARNING_NET.
 * Entrypoint only — logic lives in handler.ts so tests can import without serve().
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleAdminRecoverCapturedTripWallet } from "./handler.ts";

serve((req) => handleAdminRecoverCapturedTripWallet(req));
