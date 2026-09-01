/** Read-only MK0001/MK0002 FR reconciliation verification (no writes). */
import { createClient } from "npm:@supabase/supabase-js@2";
import { fetchDriverWalletPayoutSnapshot } from "../supabase/functions/_shared/fetchDriverWalletPayoutSnapshot.ts";

const url = Deno.env.get("SUPABASE_URL") ?? "https://thazislrdkjpvvghtvzo.supabase.co";
const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!key) {
  console.error("SUPABASE_SERVICE_ROLE_KEY required");
  Deno.exit(1);
}

const DRIVERS: Record<string, string> = {
  MK0001: "5ed232c3-8bb5-4085-95d6-73e48e6c5e28",
  MK0002: "cd8bae4c-3827-4b90-98c6-10be70eb0e52",
};

const periodFrom = "2026-08-25";
const periodTo = "2026-09-01";

const supabase = createClient(url, key);

for (const [code, driverId] of Object.entries(DRIVERS)) {
  const snap = await fetchDriverWalletPayoutSnapshot(supabase, {
    driverId,
    periodFrom,
    periodTo,
  });
  console.log(JSON.stringify({
    driver_code: code,
    expected_payable_pence: snap.expected_payable_pence,
    actual_wallet_trip_credits_pence: snap.actual_wallet_trip_credits_pence,
    verified_expected_payable_pence: snap.verified_expected_payable_pence,
    verified_wallet_credits_pence: snap.verified_wallet_credits_pence,
    unverified_wallet_credits_pence: snap.unverified_wallet_credits_pence,
    missing_stamp_trip_count: snap.missing_stamp_trip_count,
    missing_stamp_trip_codes: snap.missing_stamp_trip_codes,
    wallet_variance_pence: snap.wallet_variance_pence,
    payout_variance_pence: snap.payout_variance_pence,
    payout_ledger_completed_pence: snap.payout_ledger_completed_pence,
    driver_credit_status: snap.driver_credit_status,
    payout_status: snap.payout_status,
    query_scope_status: snap.query_scope_status,
  }, null, 2));
}
