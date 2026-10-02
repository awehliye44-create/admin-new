/**
 * LOCK — chargeable terminal earnings in the Driver Wallet (SQL ↔ TS parity).
 *
 * A TRIP_EARNING_NET for Arrival Cancellation / No-Show / Late Passenger
 * Cancellation is eligible on ledger + capture evidence (owner, capture
 * confirmed, fee ACTUAL, amount = captured − fee, commission 0, not reversed),
 * never rejected for status cancelled / cancelled_at. 27h clearing: Pending
 * first, Available after the delay. CANCELLED_NO_FEE is never payable.
 *
 * The same fixture file is evaluated against SQL driver_wallet_eligibility_balances
 * in the disposable-PostgreSQL certification. Both must produce these numbers.
 */
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { fetchDriverPayoutEligibility } from "../../functions/_shared/fetchDriverPayoutEligibility.ts";
import { buildDriverPayoutWithdrawalQuote } from "../../functions/_shared/driverPayoutWithdrawalQuoteSSOT.ts";
import { planPayoutItemFromEligibleEntries } from "../../functions/_shared/payoutLedgerHandoffSSOT.ts";
import { resolveTerminalOutcomeKind } from "../../functions/_shared/terminalOutcomeKindSSOT.ts";
import { createFakeDb, type FakeRow } from "./waitingSsotFakeDb.ts";

type Scenario = {
  id: string;
  trip: Record<string, unknown> & { owner: string; cancelled_age_s?: number | null; completed_age_s?: number | null };
  session: (Record<string, unknown> & { captured_age_s?: number | null }) | null;
  ledger: Array<{ type: string; amount_pence: number; age_s: number }>;
  expect: { pending: number; eligible: number };
};

type Fixture = {
  clearing_delay_hours: number;
  scenarios: Scenario[];
  outcome_kind_cases: Array<{
    financial_outcome: string | null;
    status: string | null;
    payment_status: string | null;
    no_show_charge_pence: number | null;
    expect: string | null;
  }>;
};

const fixture: Fixture = JSON.parse(
  Deno.readTextFileSync(new URL("./terminalWalletEligibilityParity.fixtures.json", import.meta.url)),
);

export const PARITY_NOW_ISO = "2026-10-03T12:00:00.000Z";
const NOW_MS = Date.parse(PARITY_NOW_ISO);
const OTHER_DRIVER = "00000000-0000-4000-8000-0000000000ff";

const ago = (s: number | null | undefined) => (s == null ? null : new Date(NOW_MS - s * 1000).toISOString());
const hex = (n: number) => n.toString(16).padStart(12, "0");
export const scenarioIds = (i: number) => ({
  driver: `00000000-0000-4000-8000-${hex(0x100 + i)}`,
  trip: `00000000-0000-4000-9000-${hex(0x100 + i)}`,
  session: `00000000-0000-4000-a000-${hex(0x100 + i)}`,
  ledger: (j: number) => `00000000-0000-4000-b${j.toString(16).padStart(3, "0")}-${hex(0x100 + i)}`,
});

function seedFor(s: Scenario, i: number, withVerifiedDestination = false) {
  const ids = scenarioIds(i);
  const owner = s.trip.owner;
  const trip: FakeRow = {
    id: ids.trip,
    payment_session_id: s.session ? ids.session : null,
    status: s.trip.status,
    financial_outcome: s.trip.financial_outcome ?? null,
    payment_status: s.trip.payment_status ?? null,
    no_show_charge_pence: s.trip.no_show_charge_pence ?? null,
    financial_model: s.trip.financial_model ?? "PLATFORM_COLLECTED",
    payment_collection_model: null,
    payment_method: "card",
    driver_net_pence: s.trip.driver_net_pence ?? null,
    tip_pence: 0,
    tip_amount_pence: 0,
    cancelled_at: ago(s.trip.cancelled_age_s),
    completed_at: ago(s.trip.completed_age_s),
    settlement_formula_version: null,
    provider_available_on: null,
    driver_id: owner === "driver" ? ids.driver : null,
    confirmed_driver_id: null,
    previous_driver_id: owner === "previous" ? ids.driver : owner === "other" ? OTHER_DRIVER : null,
  };
  const sessions: FakeRow[] = s.session
    ? [{
      id: ids.session,
      trip_id: ids.trip,
      status: s.session.status,
      provider_state: s.session.provider_state,
      captured_amount_pence: s.session.captured_amount_pence,
      refunded_amount_pence: s.session.refunded_amount_pence ?? 0,
      captured_at: ago(s.session.captured_age_s),
      payment_method: "card",
      metadata: {},
      provider_processing_fee_pence: s.session.provider_processing_fee_pence ?? null,
      fee_status: s.session.fee_status ?? null,
    }]
    : [];
  const ledger: FakeRow[] = s.ledger.map((l, j) => ({
    id: ids.ledger(j),
    driver_id: ids.driver,
    type: l.type,
    amount_pence: l.amount_pence,
    related_trip_id: ids.trip,
    created_at: ago(l.age_s),
    metadata: {},
  }));
  return {
    drivers: [{ id: ids.driver, payouts_enabled: true, payout_operational_paused: false, approval_status: "approved", driver_status: "active" }],
    driver_wallet_ledger: ledger,
    driver_early_cashouts: [],
    driver_payout_destinations: withVerifiedDestination
      ? [{
        id: `dest-${i}`,
        driver_id: ids.driver,
        is_active: true,
        archived_at: null,
        verification_status: "PROVIDER_VERIFIED",
        provider_link_status: "PROVIDER_VERIFIED",
        provider_counterparty_id: `cp-${i}`,
        provider_recipient_account_id: `acct-${i}`,
        account_last4: "0000",
        updated_at: new Date(NOW_MS).toISOString(),
      }]
      : [],
    admin_settings: [{ setting_key: "payout_clearing_delay_hours", setting_value: String(fixture.clearing_delay_hours) }],
    trips: [trip],
    payment_sessions: sessions,
    driver_earning_settlement: [],
    payout_item_ledger_allocations: [],
  };
}

async function evaluate(s: Scenario, i: number, withVerifiedDestination = false) {
  const db = createFakeDb(seedFor(s, i, withVerifiedDestination));
  const realNow = Date.now;
  Date.now = () => NOW_MS;
  try {
    // deno-lint-ignore no-explicit-any
    return await fetchDriverPayoutEligibility(db.client as any, { driver_id: scenarioIds(i).driver });
  } finally {
    Date.now = realNow;
  }
}

fixture.scenarios.forEach((s, i) => {
  Deno.test(`terminal wallet parity [TS]: ${s.id} → pending ${s.expect.pending} / eligible ${s.expect.eligible}`, async () => {
    const r = await evaluate(s, i);
    assertEquals(
      { pending: r.pending_balance_pence, eligible: r.eligible_earnings_pence },
      s.expect,
    );
  });
});

Deno.test("terminal wallet parity [TS]: resolveTerminalOutcomeKind matches the SQL helper truth table", () => {
  for (const c of fixture.outcome_kind_cases) {
    assertEquals(resolveTerminalOutcomeKind(c), c.expect, JSON.stringify(c));
  }
});

Deno.test("terminal wallet: MK-261002-014 never rejected because the trip is cancelled", async () => {
  const i = fixture.scenarios.findIndex((s) => s.id === "mk261002014_arrival_available_28h");
  const s = fixture.scenarios[i]!;
  assertEquals(s.trip.status, "cancelled");
  assertEquals(s.trip.driver_net_pence, 425);
  const r = await evaluate(s, i);
  assertEquals(r.eligible_entries.map((e) => e.amount_pence), [426]);
  assertEquals(r.available_balance_pence, 426);
});

/** driver-withdraw: amount = quote.withdrawable_pence, lineage = eligibility.eligible_entries. */
async function withdrawFor(s: Scenario, i: number) {
  const eligibility = await evaluate(s, i, true);
  const quote = buildDriverPayoutWithdrawalQuote({
    eligibility,
    global_payouts_enabled: true,
    payout_operational_paused: false,
    provider_verified_active_destination: true,
    driver_approved: true,
    driver_suspended: false,
    fee_pence: 0,
    minimum_pence: 0,
    early_cash_out_enabled: true,
    provider_available: true,
    financial_model_platform_collected: true,
  });
  const lineage = planPayoutItemFromEligibleEntries({
    eligible_entries: eligibility.eligible_entries,
    available_balance_pence: quote.withdrawable_pence,
  });
  return { eligibility, quote, lineage };
}

const FRESH_TERMINAL_1MIN = [
  "mk261002015_no_show_pending_1min",
  "pickup_no_show_path_completed_at_set_pending_1min",
  "mk261002014_arrival_pending_1min",
  "late_passenger_cancellation_pending_1min",
];

for (const id of FRESH_TERMINAL_1MIN) {
  Deno.test(`terminal withdraw hard gate: ${id} → Pending 426, Available 0, withdrawable 0, no lineage`, async () => {
    const i = fixture.scenarios.findIndex((s) => s.id === id);
    const s = fixture.scenarios[i]!;
    const { eligibility, quote, lineage } = await withdrawFor(s, i);
    assertEquals(eligibility.pending_balance_pence, 426);
    assertEquals(eligibility.available_balance_pence, 0);
    assertEquals(eligibility.eligible_entries.length, 0);
    assertEquals(quote.withdrawable_pence, 0);
    assertEquals(quote.payout_allowed, false);
    assertEquals(quote.blocking_reason_code, "FUNDS_CLEARING");
    assertEquals(lineage, null);
  });
}

for (const id of ["mk261002015_no_show_boundary_27h00m00s_available", "mk261002014_arrival_available_28h"]) {
  Deno.test(`terminal withdraw hard gate: ${id} → withdrawable 426 after the same 27h clearing`, async () => {
    const i = fixture.scenarios.findIndex((s) => s.id === id);
    const s = fixture.scenarios[i]!;
    const { quote, lineage } = await withdrawFor(s, i);
    assertEquals(quote.withdrawable_pence, 426);
    assertEquals(lineage?.amount_pence, 426);
    assertEquals(lineage?.allocations.map((a) => a.ledger_entry_id), [scenarioIds(i).ledger(0)]);
  });
}

Deno.test("terminal withdraw hard gate: 26:59:59 No-Show is not withdrawable, 27:00:00 is", async () => {
  for (const [id, expected] of [
    ["mk261002015_no_show_boundary_26h59m59s_pending", 0],
    ["mk261002015_no_show_boundary_27h00m00s_available", 426],
  ] as const) {
    const i = fixture.scenarios.findIndex((s) => s.id === id);
    const { quote } = await withdrawFor(fixture.scenarios[i]!, i);
    assertEquals(quote.withdrawable_pence, expected, id);
  }
});

Deno.test("terminal wallet: SQL migration carries the same terminal rule", () => {
  const sql = Deno.readTextFileSync(
    new URL(
      "../../migrations/20261205120000_terminal_wallet_eligibility_and_stamp_invariant.sql",
      import.meta.url,
    ),
  );
  for (const needle of [
    "public.trip_chargeable_terminal_outcome_kind(",
    "public.trip_terminal_entitled_driver_id(",
    "IS DISTINCT FROM p_driver_id",
    "c.type = 'PLATFORM_COMMISSION'",
    "x.type IN ('LEDGER_REVERSAL', 'REFUND_DEBIT')",
    "<> 'ACTUAL'",
    "v_canonical := v_captured - v_terminal_fee;",
    "r.amount_pence <> v_canonical",
    "(v_terminal AND upper(ps.status::text) = 'CAPTURED')",
    "WHEN lower(COALESCE(t.status, '')) = 'completed'\n                  THEN 'trip_stamp'",
  ]) {
    assertStringIncludes(sql, needle);
  }
  // The completed-trip gate stays for every non-terminal earning.
  assertStringIncludes(sql, "IF r.trip_cancelled_at IS NOT NULL THEN");
  assertStringIncludes(sql, "IF v_captured < v_canonical THEN");
});
