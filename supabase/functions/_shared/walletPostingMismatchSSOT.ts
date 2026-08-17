import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";

/**
 * Operational posting-failure breadcrumb on existing financial_ssot_mismatches.
 * Not a money SSOT. Financial Reconciliation still compares stamps vs Driver Wallet Ledger.
 */
export async function recordWalletPostingFailureMetadata(
  supabase: SupabaseClient,
  args: {
    tripId: string;
    tripCode?: string | null;
    expectedDriverCreditPence: number;
    postedDriverCreditPence?: number;
    errorMessage?: string | null;
  },
): Promise<void> {
  const expected = Math.max(0, Math.round(Number(args.expectedDriverCreditPence) || 0));
  const posted = Math.max(0, Math.round(Number(args.postedDriverCreditPence) || 0));
  const { error } = await supabase.from("financial_ssot_mismatches").upsert(
    {
      trip_id: args.tripId,
      trip_code: args.tripCode ?? null,
      stage: "wallet_posting",
      field_name: "WALLET_MISMATCH",
      expected_pence: expected,
      actual_pence: posted,
      details: {
        status: "WALLET_MISMATCH",
        error: args.errorMessage ?? null,
        difference_pence: expected - posted,
        operational: true,
      },
      detected_at: new Date().toISOString(),
    },
    { onConflict: "trip_id,stage,field_name" },
  );
  if (error) {
    console.error("[recordWalletPostingFailureMetadata] upsert failed", {
      trip_id: args.tripId,
      error: error.message,
    });
  }
}

/** Payment Sessions persist failed after provider capture — audit only, no wallet, no recapture. */
export async function recordPaymentSessionPersistFailureMetadata(
  supabase: SupabaseClient,
  args: {
    tripId: string;
    tripCode?: string | null;
    errorMessage?: string | null;
  },
): Promise<void> {
  const { error } = await supabase.from("financial_ssot_mismatches").upsert(
    {
      trip_id: args.tripId,
      trip_code: args.tripCode ?? null,
      stage: "payment_session",
      field_name: "PAYMENT_SESSION_CAPTURE_MISMATCH",
      expected_pence: 0,
      actual_pence: 0,
      details: {
        error: args.errorMessage ?? null,
        operational: true,
      },
      detected_at: new Date().toISOString(),
    },
    { onConflict: "trip_id,stage,field_name" },
  );
  if (error) {
    console.error("[recordPaymentSessionPersistFailureMetadata] upsert failed", {
      trip_id: args.tripId,
      error: error.message,
    });
  }
}

