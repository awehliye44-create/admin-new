import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateDriverTipThanks,
  isTipCaptureConfirmed,
} from "./driverTipThanksSSOT.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

const eligible = {
  driverOwnsRow: true,
  ledgerType: "DRIVER_TIP_CREDIT",
  amountPence: 100,
  captureConfirmed: true,
  bookingSource: "customer_app",
  corporateAccountId: null,
  alreadySent: false,
};

Deno.test("tip row without DRIVER_TIP_CREDIT does not allow thanks", () => {
  assertEquals(
    evaluateDriverTipThanks({ ...eligible, ledgerType: "TRIP_EARNING_NET" }).ok,
    false,
  );
  assertEquals(
    evaluateDriverTipThanks({ ...eligible, ledgerType: "TIP_CREDIT" }).ok,
    false,
  );
});

Deno.test("pending or unconfirmed capture does not allow thanks", () => {
  assertEquals(evaluateDriverTipThanks({ ...eligible, captureConfirmed: false }).ok, false);
  assertEquals(isTipCaptureConfirmed(null), false);
  assertEquals(
    isTipCaptureConfirmed({ status: "authorised", capturedAt: null, capturedAmountPence: 0 }),
    false,
  );
  assertEquals(
    isTipCaptureConfirmed({
      status: "captured",
      capturedAt: "2026-09-13T08:00:00Z",
      capturedAmountPence: 250,
    }),
    true,
  );
});

Deno.test("valid captured Customer App tip can send thanks", () => {
  assertEquals(evaluateDriverTipThanks(eligible).ok, true);
});

Deno.test("second send is already sent", () => {
  const again = evaluateDriverTipThanks({ ...eligible, alreadySent: true });
  assertEquals(again.ok, false);
  if (!again.ok) assertEquals(again.code, "ALREADY_SENT");
});

Deno.test("Corporate, WhatsApp, and Guest tips cannot send thanks", () => {
  for (const bookingSource of ["corporate", "whatsapp_booking", "guest", "guest_web"]) {
    assertEquals(
      evaluateDriverTipThanks({ ...eligible, bookingSource }).ok,
      false,
    );
  }
  assertEquals(
    evaluateDriverTipThanks({ ...eligible, corporateAccountId: "corp-1" }).ok,
    false,
  );
});

Deno.test("send-tip-thanks does not mutate wallet, capture, invoice, or FR", () => {
  const src = readFileSync(join(root, "functions/send-tip-thanks/index.ts"), "utf8");
  const sql = readFileSync(
    join(root, "migrations/20261112160000_driver_tip_thanks.sql"),
    "utf8",
  );
  for (const forbidden of [
    "driver_wallet_ledger",
    "payment_sessions",
    "invoices",
    "financial_reports",
  ]) {
    assert(!src.includes(`.from("${forbidden}")`), forbidden);
  }
  assert(src.includes('.from("driver_tip_thanks")'));
  assert(!src.includes('.from("driver_wallet_ledger").update'));
  assert(src.includes("already_sent"));
  assert(src.includes("status: \"already_sent\""));
  assert(src.includes("status: \"sent\""));
  assert(!src.includes("first_name"));
  assert(!src.includes("phone"));
  assert(sql.includes("ledger_id uuid NOT NULL UNIQUE"));
  assert(sql.includes("status = 'captured'"));
  assert(sql.includes("DRIVER_TIP_CREDIT"));
  assert(sql.includes("'whatsapp'"));
  assert(sql.includes("'guest_web'"));
  assert(!sql.includes("UPDATE public.driver_wallet_ledger"));
  assert(!sql.includes("UPDATE public.payment_sessions"));
});
