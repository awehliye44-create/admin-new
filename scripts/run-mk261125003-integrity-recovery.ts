/**
 * #92H — Evidence-only MK-261125-003 integrity recovery (local/service-role).
 * Never POSTs CAPTURE/INCREMENT. Never creates a second TEN.
 *
 *   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… \
 *     deno run --allow-net --allow-env scripts/run-mk261125003-integrity-recovery.ts
 */
import { createClient } from "npm:@supabase/supabase-js@2.57.2";
import { recoverMk261125003IntegrityGaps, MK_261125_003 } from "../supabase/functions/_shared/mk261125003RecoverySSOT.ts";

const url = Deno.env.get("SUPABASE_URL") ?? Deno.env.get("SUPABASE_SERVICE_URL");
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!url || !key) {
  console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  Deno.exit(2);
}

const supabase = createClient(url, key, { auth: { persistSession: false } });
const result = await recoverMk261125003IntegrityGaps(supabase);
console.log(JSON.stringify({ trip: MK_261125_003.tripCode, ...result }, null, 2));

if (result.tenCount !== 1 || result.tenAmountPence !== MK_261125_003.tenPence) {
  console.error("TEN invariant violated — aborting with non-zero");
  Deno.exit(1);
}
if (result.captureConfirmedPence != null && result.captureConfirmedPence !== MK_261125_003.capturedPence) {
  console.error("Capture amount invariant violated");
  Deno.exit(1);
}
console.log("OK: recovery complete; TEN/capture invariants held");
