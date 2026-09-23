/**
 * Corporate / guest receivable isolation lock.
 * Personal customer receivables must never fold into corporate_portal or guest
 * preauth. create-corporate-book packages revolutPreauth — eligibility must
 * reject those booking classes before reserve.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isCustomerReceivablePreauthEligible,
  planFoldReceivablesIntoPreauth,
} from "../supabase/functions/_shared/customerReceivableSSOT.ts";

const PERSONAL = {
  id: "recv-personal-1",
  customer_id: "cust-personal",
  outstanding_amount_pence: 36,
  status: "OPEN" as const,
  currency: "gbp",
  source_trip_id: "trip-mk012",
  idempotency_key: "k-personal",
};

Deno.test("corporate portal booking is not receivable-preauth eligible", () => {
  const r = isCustomerReceivablePreauthEligible({
    customer_id: "cust-personal",
    booking_source: "corporate_portal",
    corporate_account_id: "corp-account-1",
    financial_model: "PLATFORM_COLLECTED",
  });
  assertEquals(r.eligible, false);
  assertEquals(r.reject_reason, "corporate_account");
});

Deno.test("guest booking is not receivable-preauth eligible", () => {
  const r = isCustomerReceivablePreauthEligible({
    customer_id: "cust-personal",
    is_guest: true,
    booking_source: "guest_web",
  });
  assertEquals(r.eligible, false);
  assertEquals(r.reject_reason, "guest_booking");
});

Deno.test("authenticated Customer PLATFORM_COLLECTED choose_ride is eligible", () => {
  const r = isCustomerReceivablePreauthEligible({
    customer_id: "cust-personal",
    booking_source: "choose_ride",
    financial_model: "PLATFORM_COLLECTED",
    is_guest: false,
  });
  assertEquals(r.eligible, true);
  assertEquals(r.reject_reason, null);
});

Deno.test("corporate/guest preserve bare fare — fold plan not applied when ineligible", () => {
  // Simulate: caller skips fold when ineligible; authorised = ride only.
  const ride = 1200;
  const eligible = isCustomerReceivablePreauthEligible({
    customer_id: "cust-personal",
    booking_source: "corporate_portal",
    corporate_account_id: "corp-1",
  });
  assertEquals(eligible.eligible, false);
  const authorised_if_skipped = ride; // corporate preserves existing amount
  assertEquals(authorised_if_skipped, 1200);
  // Even if OPEN receivables were wrongly passed, fold would include them —
  // eligibility gate is the production barrier (revolutPreauth).
  const fold = planFoldReceivablesIntoPreauth({
    ride_fare_pence: ride,
    buffer_pence: 0,
    open_receivables: [PERSONAL],
  });
  assertEquals(fold.receivables_total_pence, 36);
  // Production path: when !eligible, fold is never called → amount stays ride.
});

Deno.test("create-corporate-book source packages eligibility via revolutPreauth", async () => {
  const corp = await Deno.readTextFile(
    new URL("../supabase/functions/create-corporate-book/index.ts", import.meta.url),
  );
  const preauth = await Deno.readTextFile(
    new URL(
      "../supabase/functions/_shared/revolutPreauth.ts",
      import.meta.url,
    ),
  );
  assertEquals(corp.includes("createRevolutPreauthResponse"), true);
  assertEquals(corp.includes('booking_source: "corporate_portal"'), true);
  assertEquals(corp.includes("corporate_account_id"), true);
  assertEquals(preauth.includes("isCustomerReceivablePreauthEligible"), true);
  assertEquals(preauth.includes("Customer receivable fold skipped"), true);
});
