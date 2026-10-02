#!/usr/bin/env python3
"""
Generate the disposable-PostgreSQL certification for
20261205120000_terminal_wallet_eligibility_and_stamp_invariant.sql.

Reads the shared fixture (supabase/tests/_shared/terminalWalletEligibilityParity.fixtures.json)
that the Deno parity lock evaluates in TS, and emits one transaction that:
  - seeds every scenario (triggers off for seeding only; CHECK constraints stay on)
  - compares driver_wallet_eligibility_balances to the fixture expectation
  - compares trip_chargeable_terminal_outcome_kind to the TS truth table
  - checks Today's earnings (driver_wallet_resolve_economic_date / in_range)
  - checks list_driver_own_trip_history payable for terminal / no-fee / completed
  - exercises trips_driver_net_pence_matches_breakdown, incl. the real stamp
    UPDATE through the production trips triggers
and ROLLs BACK. Output: rows of (section, case, expected, actual, pass).

Usage: python3 terminal_wallet_eligibility_parity_verify.py [--baseline] > /tmp/cert.sql
       --baseline: for a database WITHOUT the migration. The old CHECK rejects a
       correctly stamped terminal row, so seeding lifts it and re-adds it NOT VALID.
       psql -d <disposable db> -f /tmp/cert.sql
Never run against production.
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FIX = json.load(open(os.path.join(HERE, "_shared", "terminalWalletEligibilityParity.fixtures.json")))
OTHER = "00000000-0000-4000-8000-0000000000ff"
REGION = "00000000-0000-4000-8000-0000000000aa"
AREA = "00000000-0000-4000-8000-0000000000ab"


def hx(n):
    return format(n, "012x")


def ids(i):
    return {
        "driver": f"00000000-0000-4000-8000-{hx(0x100 + i)}",
        "user": f"00000000-0000-4000-c000-{hx(0x100 + i)}",
        "trip": f"00000000-0000-4000-9000-{hx(0x100 + i)}",
        "session": f"00000000-0000-4000-a000-{hx(0x100 + i)}",
        "ledger": lambda j: f"00000000-0000-4000-b{format(j, '03x')}-{hx(0x100 + i)}",
    }


def lit(v):
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def ago(s):
    return "NULL" if s is None else f"(v_now - make_interval(secs => {s}))"


out = []
w = out.append
w("\\set ON_ERROR_STOP 1")
w("BEGIN;")
w("CREATE TEMP TABLE cert(section text, name text, expected text, actual text, pass boolean) ON COMMIT DROP;")
w("SET LOCAL session_replication_role = replica;")
BASELINE = "--baseline" in sys.argv
OLD_CHECK = ("ALTER TABLE public.trips ADD CONSTRAINT trips_driver_net_pence_matches_breakdown CHECK ("
             "(driver_net_pence IS NULL) OR (gross_fare_pence IS NULL) OR (commission_pence IS NULL) "
             "OR (driver_net_pence = (gross_fare_pence - commission_pence))) NOT VALID;")
if BASELINE:
    w("ALTER TABLE public.trips DROP CONSTRAINT trips_driver_net_pence_matches_breakdown;")
w("DO $seed$")
w("DECLARE v_now timestamptz := now();")
w("BEGIN")
for i, s in enumerate(FIX["scenarios"]):
    d = ids(i)
    t = s["trip"]
    owner = t["owner"]
    w(f"  INSERT INTO public.drivers(id, user_id, email, first_name, last_name, phone, region_id, payout_operational_paused)"
      f" VALUES ('{d['driver']}', '{d['user']}', 'cert{i}@example.invalid', 'Cert', '{s['id'][:40]}', '+4470000{i:05d}', '{REGION}', false);")
    w("  INSERT INTO public.trips(id, trip_number, passenger_id, pickup_address, dropoff_address, financial_model, payment_method,"
      " status, financial_outcome, payment_status, no_show_charge_pence, gross_fare_pence, commission_pence, driver_net_pence,"
      " provider_fee_pence, capture_amount_pence, cancellation_fee_pence, late_cancel_fee_pence, cancelled_at, completed_at,"
      " driver_id, confirmed_driver_id, previous_driver_id, payment_session_id) VALUES ("
      f"'{d['trip']}', 'CERT-{i:03d}', '{d['user']}', 'A', 'B', {lit(t.get('financial_model', 'PLATFORM_COLLECTED'))}::public.service_area_financial_model, 'card',"
      f" {lit(t['status'])}, {lit(t.get('financial_outcome'))}, {lit(t.get('payment_status'))}, {lit(t.get('no_show_charge_pence'))},"
      f" {lit(t.get('gross_fare_pence'))}, {lit(t.get('commission_pence'))}, {lit(t.get('driver_net_pence'))},"
      f" {lit(t.get('provider_fee_pence'))}, {lit(t.get('capture_amount_pence'))}, {lit(t.get('cancellation_fee_pence'))}, {lit(t.get('late_cancel_fee_pence'))},"
      f" {ago(t.get('cancelled_age_s'))}, {ago(t.get('completed_age_s'))},"
      f" {lit(d['driver'] if owner == 'driver' else None)}, NULL, {lit(d['driver'] if owner == 'previous' else OTHER if owner == 'other' else None)},"
      f" {lit(d['session'] if s['session'] else None)});")
    ps = s["session"]
    if ps:
        released = ps.get("released_amount_pence") or 0
        w("  INSERT INTO public.payment_sessions(id, trip_id, user_id, service_area_id, client_action_id, idempotency_key, purpose, status,"
          " provider_state, hold_release_state, captured_amount_pence, released_amount_pence, refunded_amount_pence, authorised_amount_pence,"
          " fee_status, provider_processing_fee_pence, captured_at, released_at, provider_state_verified_at, payment_method, metadata) VALUES ("
          f"'{d['session']}', '{d['trip']}', '{d['user']}', '{AREA}', 'cert-{i}', 'cert-{i}', 'RIDE_BOOKING', {lit(ps['status'])}::public.payment_session_status,"
          f" {lit(ps.get('provider_state'))}, {lit(ps.get('hold_release_state'))}, {lit(ps.get('captured_amount_pence'))}, {lit(released)}, {lit(ps.get('refunded_amount_pence', 0))}, {lit(ps.get('authorised_amount_pence'))},"
          f" {lit(ps.get('fee_status'))}::public.payment_session_fee_status, {lit(ps.get('provider_processing_fee_pence'))}, {ago(ps.get('captured_age_s'))},"
          f" {('NULL' if not released else ago(max(0, (ps.get('captured_age_s') or 0) - 1)))}, {ago(ps.get('captured_age_s'))}, 'card', '{{}}'::jsonb);")
    for j, l in enumerate(s["ledger"]):
        w("  INSERT INTO public.driver_wallet_ledger(id, driver_id, type, amount_pence, related_trip_id, created_at, metadata) VALUES ("
          f"'{d['ledger'](j)}', '{d['driver']}', {lit(l['type'])}, {l['amount_pence']}, '{d['trip']}', {ago(l['age_s'])}, '{{}}'::jsonb);")

# History-only trips (no ledger): MK-260927-013 / MK-260926-002 shapes.
HIST = [
    ("hist_mk260927013_no_fee", 500, 75, 425),
    ("hist_mk260926002_no_fee", 750, 101, 649),
]
hist_base = len(FIX["scenarios"])
for k, (name, g, c, n) in enumerate(HIST):
    d = ids(hist_base + k)
    w(f"  INSERT INTO public.drivers(id, user_id, email, first_name, last_name, phone, region_id, payout_operational_paused)"
      f" VALUES ('{d['driver']}', '{d['user']}', 'certh{k}@example.invalid', 'Cert', '{name}', '+4471000{k:05d}', '{REGION}', false);")
    w("  INSERT INTO public.trips(id, trip_number, passenger_id, pickup_address, dropoff_address, financial_model, payment_method,"
      " status, financial_outcome, payment_status, gross_fare_pence, commission_pence, driver_net_pence, driver_total_earnings_pence,"
      " cancelled_at, previous_driver_id) VALUES ("
      f"'{d['trip']}', 'CERT-H{k}', '{d['user']}', 'A', 'B', 'PLATFORM_COLLECTED', 'card', 'cancelled', 'CANCELLED_NO_FEE', 'released',"
      f" {g}, {c}, {n}, {n}, (v_now - interval '5 days'), '{d['driver']}');")
w("END")
w("$seed$;")
if BASELINE:
    w(OLD_CHECK)
w("SET LOCAL session_replication_role = origin;")
w("SET LOCAL request.jwt.claims = '{\"role\":\"service_role\"}';")

# 1. Wallet parity.
for i, s in enumerate(FIX["scenarios"]):
    d = ids(i)
    e = s["expect"]
    w("INSERT INTO cert SELECT 'wallet', " + lit(s["id"]) + ", "
      f"'pending={e['pending']} eligible={e['eligible']}', "
      "format('pending=%s eligible=%s', b.pending_balance_pence, b.eligible_earnings_pence), "
      f"b.pending_balance_pence = {e['pending']} AND b.eligible_earnings_pence = {e['eligible']} "
      f"FROM public.driver_wallet_eligibility_balances('{d['driver']}') b;")

# 1b. Withdrawal side: reserve/summary read Available through the same SSOT.
for i, s in enumerate(FIX["scenarios"]):
    d = ids(i)
    e = s["expect"]
    w("INSERT INTO cert SELECT 'withdraw_available', " + lit(s["id"]) + f", '{e['eligible']}', "
      f"public.driver_wallet_available_for_payout_pence('{d['driver']}')::text, "
      f"public.driver_wallet_available_for_payout_pence('{d['driver']}') = {e['eligible']};")
for name in [
    "mk261002015_no_show_pending_1min",
    "mk261002015_no_show_boundary_26h59m59s_pending",
    "mk261002015_no_show_boundary_27h00m00s_available",
    "pickup_no_show_path_completed_at_set_pending_1min",
    "mk261002014_arrival_pending_1min",
    "late_passenger_cancellation_pending_1min",
]:
    i, s = next((k, x) for k, x in enumerate(FIX["scenarios"]) if x["id"] == name)
    d = ids(i)
    e = s["expect"]
    exp = f"pending={e['pending']} available_for_payout={e['eligible']} early_cash_out_available={e['eligible']}"
    w("INSERT INTO cert SELECT 'withdraw_summary', " + lit(name) + f", {lit(exp)}, "
      "format('pending=%s available_for_payout=%s early_cash_out_available=%s', j->>'pending_balance_pence', "
      "j->>'available_for_payout_pence', j->>'early_cash_out_available_pence'), "
      f"coalesce((j->>'pending_balance_pence')::bigint = {e['pending']} "
      f"AND (j->>'available_for_payout_pence')::bigint = {e['eligible']} "
      f"AND (j->>'early_cash_out_available_pence')::bigint = {e['eligible']}, false) "
      f"FROM public.driver_wallet_summary_ssot('{d['driver']}', NULL) j;")
    if (s["session"].get("captured_age_s") or 0) < 3600:
        w("INSERT INTO cert SELECT 'today_summary', " + lit(name) + ", '426', "
          "coalesce(j->>'today_trip_earnings_pence', 'NULL'), coalesce((j->>'today_trip_earnings_pence')::bigint = 426, false) "
          f"FROM public.driver_wallet_summary_ssot('{d['driver']}', NULL) j;")

# 2. Outcome-kind truth table (TS resolveTerminalOutcomeKind).
vals = []
for c in FIX["outcome_kind_cases"]:
    vals.append("(" + ", ".join([lit(c["financial_outcome"]), lit(c["status"]), lit(c["payment_status"]),
                                  ("NULL::int" if c["no_show_charge_pence"] is None else str(c["no_show_charge_pence"])),
                                  lit(c["expect"])]) + ")")
w("DO $kind$ BEGIN IF to_regproc('public.trip_chargeable_terminal_outcome_kind') IS NULL THEN "
  "INSERT INTO cert VALUES ('outcome_kind', 'helper present', 'present', 'missing', false); RETURN; END IF;")
w("EXECUTE $q$ INSERT INTO cert SELECT 'outcome_kind', 'truth table (' || count(*) || ' cases)', '0 mismatches', "
  "count(*) FILTER (WHERE public.trip_chargeable_terminal_outcome_kind(fo, st, ps, ns) IS DISTINCT FROM ex) || ' mismatches', "
  "count(*) FILTER (WHERE public.trip_chargeable_terminal_outcome_kind(fo, st, ps, ns) IS DISTINCT FROM ex) = 0 FROM (VALUES "
  + ", ".join(vals) + ") v(fo, st, ps, ns, ex) $q$; END $kind$;")

# 3. Today's earnings (economic date) for the terminal earning.
def scen(name):
    for i, s in enumerate(FIX["scenarios"]):
        if s["id"] == name:
            return i, s
    raise KeyError(name)


for name, exp_status, exp_today in [
    ("mk261002014_arrival_pending_1h", "RESOLVED", 426),
    ("late_passenger_cancellation_pending", "RESOLVED", 426),
    ("mk261002015_no_show_pending_1min", "RESOLVED", 426),
    ("pickup_no_show_path_completed_at_set_pending_1min", "RESOLVED", 426),
    ("mk261002014_arrival_pending_1min", "RESOLVED", 426),
    ("completed_trip_pending_unchanged", "RESOLVED", 850),
    ("cancelled_no_fee_never_payable", "CAPTURE_RELEASED", 0),
    ("terminal_full_release_voided_excluded", "CAPTURE_RELEASED", None),
]:
    i, s = scen(name)
    d = ids(i)
    w("INSERT INTO cert SELECT 'economic_date', " + lit(name) + f", '{exp_status}', e.economic_date_status, "
      f"e.economic_date_status = '{exp_status}' FROM public.driver_wallet_ledger l, "
      "LATERAL public.driver_wallet_resolve_economic_date(l.type, l.related_trip_id, l.created_at) e "
      f"WHERE l.id = '{d['ledger'](0)}';")
    if exp_today is not None:
        w("INSERT INTO cert SELECT 'today_earnings', " + lit(name) + f", '{exp_today}', "
          f"public.driver_wallet_trip_earnings_in_range_pence('{d['driver']}', now() - interval '6 hours', now() + interval '1 minute')::text, "
          f"public.driver_wallet_trip_earnings_in_range_pence('{d['driver']}', now() - interval '6 hours', now() + interval '1 minute') = {exp_today};")
i, s = scen("mk261002014_arrival_pending_1h")
d = ids(i)
w("INSERT INTO cert SELECT 'economic_date', 'mk261002014 economic_earned_at = captured_at', 'captured_at', "
  "coalesce(e.economic_earned_at::text, 'NULL'), e.economic_earned_at = ps.captured_at "
  f"FROM public.driver_wallet_ledger l JOIN public.payment_sessions ps ON ps.id = '{d['session']}', "
  "LATERAL public.driver_wallet_resolve_economic_date(l.type, l.related_trip_id, l.created_at) e "
  f"WHERE l.id = '{d['ledger'](0)}';")

# 4. Driver history payable.
HIST_CASES = [
    ("mk261002014_arrival_available_28h", None, "426", "terminal_ledger"),
    ("mk261002015_no_show_available", None, "426", "terminal_ledger"),
    ("mk261002015_no_show_pending_1min", None, "426", "terminal_ledger"),
    ("pickup_no_show_path_completed_at_set_pending_1min", None, "426", "terminal_ledger"),
    ("completed_trip_available_unchanged", None, "850", "trip_stamp"),
]
for name, _, exp_amt, exp_src in HIST_CASES:
    i, s = scen(name)
    d = ids(i)
    w(f"SET LOCAL request.jwt.claims = '{{\"sub\":\"{d['user']}\",\"role\":\"authenticated\"}}';")
    w("INSERT INTO cert SELECT 'history', " + lit(name) + f", '{exp_amt}/{exp_src}', "
      "coalesce(h->>'payable_amount_pence','NULL') || '/' || coalesce(h->>'payable_source','NULL'), "
      f"h->>'payable_amount_pence' = '{exp_amt}' AND h->>'payable_source' = '{exp_src}' "
      f"FROM jsonb_array_elements(public.list_driver_own_trip_history(50, NULL, NULL, '{d['trip']}')) h;")
for k, (name, g, c, n) in enumerate(HIST):
    d = ids(hist_base + k)
    w(f"SET LOCAL request.jwt.claims = '{{\"sub\":\"{d['user']}\",\"role\":\"authenticated\"}}';")
    w("INSERT INTO cert SELECT 'history', " + lit(name) + ", '0/NULL', "
      "coalesce(h->>'payable_amount_pence','NULL') || '/' || coalesce(h->>'payable_source','NULL'), "
      "h->>'payable_amount_pence' = '0' AND h->>'payable_source' IS NULL "
      f"FROM jsonb_array_elements(public.list_driver_own_trip_history(50, NULL, NULL, '{d['trip']}')) h;")
w("SET LOCAL request.jwt.claims = '{\"role\":\"service_role\"}';")

# 5. Constraint cases (each in its own savepoint).
i014, _ = scen("mk261002014_arrival_pending_1h")
icmp, _ = scen("completed_trip_available_unchanged")
inof = hist_base
T014, TCMP, TNOF = ids(i014)["trip"], ids(icmp)["trip"], ids(inof)["trip"]
STAMP = ("status='cancelled', financial_outcome='ARRIVAL_CANCELLATION', capture_amount_pence=450, commission_pct=0,"
         " payment_method='card', updated_at=now(), final_fare_pence=450, commissionable_fare_pence=450, commission_pence=0,"
         " driver_net_pence=426, driver_net_before_tip_pence=426, driver_total_earnings_pence=426, airport_charge_pence=0,"
         " tip_pence=0, tip_amount_pence=0, driver_tier_commission_percent=0, gross_fare_pence=450, provider_fee_pence=24,"
         " onecab_net_pence=0, platform_gross_revenue_pence=0, platform_net_revenue_pence=0, settlement_formula_version='2'")
CASES = [
    ("C1 real terminal stamp UPDATE through prod triggers (450/0/24/426)", T014, STAMP, True),
    ("C2 settled terminal with fee omitted (450/0/fee24/net450)", T014,
     "gross_fare_pence=450, commission_pence=0, provider_fee_pence=24, capture_amount_pence=450, driver_net_pence=450", False),
    ("C3 terminal stale booking quote stays valid (500/75/425, fee 24, cap 450)", T014,
     "gross_fare_pence=500, commission_pence=75, driver_net_pence=425, provider_fee_pence=24, capture_amount_pence=450", True),
    ("C4 terminal with commission and fee rejected (450/10/24/416)", T014,
     "gross_fare_pence=450, commission_pence=10, provider_fee_pence=24, capture_amount_pence=450, driver_net_pence=416", False),
    ("C5 terminal with NULL fee cannot net it off (450/0/NULL/426)", T014,
     "gross_fare_pence=450, commission_pence=0, provider_fee_pence=NULL, capture_amount_pence=450, driver_net_pence=426", False),
    ("C6 completed identity unchanged (1000/150/850)", TCMP,
     "gross_fare_pence=1000, commission_pence=150, driver_net_pence=850", True),
    ("C7 completed off-by-one still rejected (1000/150/851)", TCMP,
     "gross_fare_pence=1000, commission_pence=150, driver_net_pence=851", False),
    ("C8 completed may not net off a provider fee (1000/150/30/820)", TCMP,
     "gross_fare_pence=1000, commission_pence=150, provider_fee_pence=30, driver_net_pence=820", False),
    ("C9 completed with fee keeps old identity (1000/150/30/850)", TCMP,
     "gross_fare_pence=1000, commission_pence=150, provider_fee_pence=30, driver_net_pence=850", True),
    ("C10 non-terminal CANCELLED_NO_FEE may not net off a fee (450/0/24/426)", TNOF,
     "gross_fare_pence=450, commission_pence=0, provider_fee_pence=24, capture_amount_pence=450, driver_net_pence=426", False),
]
for name, trip, setc, ok in CASES:
    w("DO $c$ BEGIN BEGIN "
      f"UPDATE public.trips SET {setc} WHERE id = '{trip}'; "
      "INSERT INTO cert VALUES ('constraint', " + lit(name) + f", {lit('accepted' if ok else 'rejected')}, 'accepted', {lit(ok)}); "
      "RAISE EXCEPTION 'cert_rollback_marker'; "
      "EXCEPTION WHEN check_violation THEN "
      "INSERT INTO cert VALUES ('constraint', " + lit(name) + f", {lit('accepted' if ok else 'rejected')}, 'rejected: ' || SQLERRM, {lit(not ok)}); "
      "WHEN raise_exception THEN IF SQLERRM <> 'cert_rollback_marker' THEN RAISE; END IF; "
      "INSERT INTO cert VALUES ('constraint', " + lit(name) + f", {lit('accepted' if ok else 'rejected')}, 'accepted', {lit(ok)}); "
      "END; END $c$;")

# C1 also: the stamp leaves completed_at NULL and the status cancelled.
w("DO $c$ DECLARE r record; BEGIN BEGIN "
  f"UPDATE public.trips SET {STAMP} WHERE id = '{T014}'; "
  f"SELECT status, completed_at, driver_net_pence, gross_fare_pence, commission_pence, provider_fee_pence INTO r FROM public.trips WHERE id = '{T014}'; "
  "RAISE EXCEPTION 'cert_rollback_marker'; "
  "EXCEPTION WHEN check_violation THEN INSERT INTO cert VALUES ('stamp', 'C1 readback', 'stamped', 'rejected: ' || SQLERRM, false); "
  "WHEN raise_exception THEN IF SQLERRM <> 'cert_rollback_marker' THEN RAISE; END IF; "
  "INSERT INTO cert VALUES ('stamp', 'C1 readback cancelled / completed_at NULL / 426 = 450 - 0 - 24', 'cancelled/NULL/426/450/0/24', "
  "format('%s/%s/%s/%s/%s/%s', r.status, coalesce(r.completed_at::text,'NULL'), r.driver_net_pence, r.gross_fare_pence, r.commission_pence, r.provider_fee_pence), "
  "r.status = 'cancelled' AND r.completed_at IS NULL AND r.driver_net_pence = 426 AND r.gross_fare_pence - r.commission_pence - r.provider_fee_pence = r.driver_net_pence); "
  "END; END $c$;")

w("SELECT section, name, expected, actual, CASE WHEN pass THEN 'PASS' ELSE 'FAIL' END AS result FROM cert ORDER BY section, name;")
w("SELECT count(*) FILTER (WHERE pass) AS passed, count(*) FILTER (WHERE pass IS NOT TRUE) AS failed, count(*) AS total FROM cert;")
w("ROLLBACK;")
print("\n".join(out))
