/**
 * Lock: PLATFORM_COLLECTED and DRIVER_COLLECTED_COMMISSION_WALLET stay isolated.
 * If this fails, fix the code — never delete or soften the lock.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/from_file_url.ts";
import { join } from "https://deno.land/std@0.224.0/path/join.ts";

const REPO_ROOT = fromFileUrl(new URL("../../..", import.meta.url));

async function read(rel: string): Promise<string> {
  return await Deno.readTextFile(join(REPO_ROOT, rel));
}

Deno.test("financial model isolation lock", async () => {
  const stampWhileNullable = await read(
    "supabase/migrations/20260927180050_stamp_trip_financial_model_while_nullable.sql",
  );
  const migration = await read(
    "supabase/migrations/20260927180100_financial_model_isolation.sql",
  );
  const ssot = await read("supabase/functions/_shared/commissionWalletSSOT.ts");
  const deduction = await read(
    "supabase/functions/_shared/commissionWalletDeduction.ts",
  );
  const booking = await read("supabase/functions/_shared/bookingSSOT.ts");
  const ctap = await read("supabase/functions/create-trip-after-payment/index.ts");
  const recapture = await read(
    "supabase/functions/admin-recapture-trip-shortfall/index.ts",
  );
  const recovery = await read(
    "supabase/functions/create-payment-recovery/index.ts",
  );
  const preauth = await read(
    "supabase/functions/create-preauth-payment-intent/index.ts",
  );
  const noShow = await read("supabase/functions/_shared/noShowSettlement.ts");
  const refund = await read("supabase/functions/_shared/applyProviderRefund.ts");
  const ledger = await read("supabase/functions/_shared/onecabFinanceLedger.ts");
  const chargeFee = await read("supabase/functions/charge-lifecycle-fee/index.ts");
  const capture = await read(
    "supabase/functions/_shared/revolutCompletionCapture.ts",
  );
  const adjustment = await read(
    "supabase/functions/admin-driver-adjustment/index.ts",
  );
  const eligibility = await read(
    "supabase/functions/_shared/driverPayoutEligibilitySSOT.ts",
  );
  const stopWorkflow = await read("supabase/functions/stop-workflow/index.ts");
  const lostPropertyTransition = await read(
    "supabase/functions/lost-property-transition/index.ts",
  );

  assert(stampWhileNullable.includes("trg_00_stamp_trip_financial_model_on_insert"));
  assert(stampWhileNullable.includes("Column stays nullable"));
  assert(stampWhileNullable.includes("Unpaired service areas"));
  assert(stampWhileNullable.includes("v_sa.financial_model IS NULL"));
  assert(!stampWhileNullable.includes("SET NOT NULL"));
  assert(migration.includes("FINANCIAL_MODEL_VIOLATION"));
  assert(migration.includes("COMMISSION_SUBSIDY_CREDIT"));
  assert(migration.includes("trg_00_stamp_trip_financial_model_on_insert"));
  assert(migration.includes("trg_10_commission_wallet_on_trip_assignment"));
  assert(migration.includes("Kampala"));
  assert(migration.includes("DRIVER_COLLECTS_UPFRONT"));
  assert(!migration.includes("AUTO_DEDUCT_HISTORICAL"));
  assert(migration.includes("ADMIN_CREDIT Commission Wallet rows are intentionally unchanged"));
  assert(migration.includes("CASH_COMMISSION_DEBT"));
  assert(!/trg_commission_wallet_on_trip_complete[\s\S]*EXCEPTION WHEN OTHERS/.test(migration));

  const classifier = migration.slice(
    migration.indexOf("trip_row_is_commission_wallet_driver_collected"),
    migration.indexOf("driver_commission_wallet_balance_parts"),
  );
  assert(!classifier.includes("service_areas"));
  assert(classifier.includes("DRIVER_COLLECTED_COMMISSION_WALLET"));

  assert(ssot.includes("planCommissionWalletTripPromotion"));
  assert(ssot.includes("COMMISSION_SUBSIDY_CREDIT"));
  assert(ssot.includes("isAdminCommissionWalletCreditCustomerFarePromotion"));
  assert(ssot.includes("FINANCIAL_MODEL_VIOLATION"));
  assert(ssot.includes("void input.serviceAreaConfig"));
  assert(ssot.includes("TRANSITIONAL_NULL_FINANCIAL_MODEL_IS_PLATFORM"));
  assert(ssot.includes("readTripFinancialModelStamp"));
  assert(!deduction.includes("resolveTripFinancialModelOrTransitionalPlatform"));
  assert(!recovery.includes("resolveTripFinancialModelOrTransitionalPlatform"));
  assert(!recapture.includes("resolveTripFinancialModelOrTransitionalPlatform"));
  assert(deduction.includes("readTripFinancialModelStamp"));
  assert(recovery.includes("readTripFinancialModelStamp"));
  assert(recapture.includes("readTripFinancialModelStamp"));
  assert(migration.includes("reverse every balance-affecting DWL effect"));

  assert(!deduction.includes('.from("service_areas")'));
  assert(booking.includes("financialModelSnapshot"));
  assert(ctap.includes("skipPlatformPreauth"));
  assert(ctap.includes("FINANCIAL_MODEL_VIOLATION"));
  assert(!recapture.includes("sa?.financial_model"));
  assert(!recovery.includes("sa?.financial_model"));

  assert(preauth.includes("shouldSkipPlatformPreauthForCommissionWallet"));
  assert(preauth.includes("FINANCIAL_MODEL_VIOLATION"));
  assert(noShow.includes("financialModel"));
  assert(noShow.includes("DRIVER_COLLECTED_COMMISSION_WALLET"));
  assert(refund.includes("FINANCIAL_MODEL_VIOLATION"));
  assert(ledger.includes("FINANCIAL_MODEL_VIOLATION"));
  assert(!ledger.includes("skip DWL credit"));
  assert(chargeFee.includes("FINANCIAL_MODEL_VIOLATION"));
  assert(capture.includes("FINANCIAL_MODEL_VIOLATION"));
  assert(adjustment.includes("FINANCIAL_MODEL_VIOLATION"));
  assert(eligibility.includes("resolveFinancialModelStamp"));
  assert(eligibility.includes("FINANCIAL_MODEL.DRIVER_COLLECTED_COMMISSION_WALLET"));
  assert(eligibility.includes("FINANCIAL_MODEL.PLATFORM_COLLECTED"));
  assert(stopWorkflow.includes("mayPostDriverWalletLedger"));
  assert(stopWorkflow.includes('tripFinancialModel === "PLATFORM_COLLECTED"'));
  assert(lostPropertyTransition.includes("financial_model: financialModel"));
  const lostProperty = await read("supabase/functions/lost-property/index.ts");
  assert(lostProperty.includes("classifyServiceAreaFinancialPairing"));
  assert(!lostProperty.includes("if (!isCommissionWalletWorkflowEnabled(cwConfig)) return {};"));
  const createRide = await read("supabase/functions/create-ride/index.ts");
  const createTripRequest = await read("supabase/functions/create-trip-request/index.ts");
  const calculateFare = await read("supabase/functions/calculate-fare/index.ts");
  assert(createRide.includes("USE_CREATE_TRIP_AFTER_PAYMENT"));
  assert(createTripRequest.includes("USE_CREATE_TRIP_AFTER_PAYMENT"));
  assert(calculateFare.includes('import { corsHeaders } from "../_shared/corsHeaders.ts"'));
  assert(calculateFare.includes("skip_platform_preauth"));
  assert(migration.includes("LEDGER_REVERSAL"));
  assert(migration.includes("FROM public.service_areas WHERE id = NEW.service_area_id"));

  // Auth/customer delete must be allowed to SET NULL payment_sessions.customer_id
  // without re-raising DRIVER_COLLECTED Payment Session create gate.
  // 20261106130000 is the live fix (120000 wrongly referenced amount_pence).
  const authDeleteDetach = await read(
    "supabase/migrations/20261106130000_auth_delete_payment_session_detach_fix.sql",
  );
  assert(authDeleteDetach.includes("enforce_payment_session_financial_model"));
  assert(authDeleteDetach.includes("NEW.customer_id IS NULL"));
  assert(authDeleteDetach.includes("OLD.customer_id IS NOT NULL"));
  assert(authDeleteDetach.includes("to_jsonb(NEW) - 'customer_id'"));
  assert(authDeleteDetach.includes("Detach-only cascade"));
  assert(!authDeleteDetach.includes("NEW.amount_pence"));
  assert(!authDeleteDetach.includes("OLD.amount_pence"));
  assert(
    authDeleteDetach.includes(
      "Payment Session forbidden on DRIVER_COLLECTED_COMMISSION_WALLET",
    ),
  );

  // Driver Auth delete must detach (SET NULL), not CASCADE-erase finance FKs.
  const driverAuthDetach = await read(
    "supabase/migrations/20261106140000_auth_delete_driver_retain_financial_history.sql",
  );
  assert(driverAuthDetach.includes("drivers_user_id_fkey"));
  assert(driverAuthDetach.includes("ON DELETE SET NULL"));
  assert(driverAuthDetach.includes("drivers_on_auth_detach"));
  assert(driverAuthDetach.includes("deleted+"));

  assertEquals("FINANCIAL_MODEL_VIOLATION", "FINANCIAL_MODEL_VIOLATION");
});
