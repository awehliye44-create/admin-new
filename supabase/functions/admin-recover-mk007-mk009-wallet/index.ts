/**
 * Temporary Step 4F.1 dry-run recovery for MK-260817-007 and MK-260817-009.
 * Entrypoint only — logic lives in handler.ts so tests can import without serve().
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { handleAdminRecoverMk007Mk009Wallet } from "./handler.ts";

serve((req) => handleAdminRecoverMk007Mk009Wallet(req));
