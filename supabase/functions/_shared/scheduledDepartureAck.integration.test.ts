/**
 * Phase 5 — PostgreSQL concurrency for departure acknowledgement.
 * Not production. No Revolut.
 *
 * Run (Docker required):
 *   deno test --no-check --allow-run --allow-net --allow-env \
 *     supabase/functions/_shared/scheduledDepartureAck.integration.test.ts
 */
import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const PG_PORT = 55436;
const DATABASE_URL =
  `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/postgres`;
const TRIP = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const D1 = "11111111-1111-1111-1111-111111111111";
const D2 = "22222222-2222-2222-2222-222222222222";

async function sh(cmd: string[]): Promise<{ code: number; out: string }> {
  const p = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await p.output();
  return {
    code,
    out: new TextDecoder().decode(stdout) + new TextDecoder().decode(stderr),
  };
}

async function psql(sql: string): Promise<string> {
  const { code, out } = await sh([
    "psql",
    DATABASE_URL,
    "-v",
    "ON_ERROR_STOP=1",
    "-Atc",
    sql,
  ]);
  if (code !== 0) throw new Error(`psql failed: ${out}`);
  return out.trim();
}

Deno.test({
  name: "PG: Phase 5 departure-ack races — ack vs timeout/cancel/reassign/payment",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await sh(["docker", "rm", "-f", "p5-ack-pg"]);
    const run = await sh([
      "docker",
      "run",
      "-d",
      "--name",
      "p5-ack-pg",
      "-e",
      "POSTGRES_PASSWORD=postgres",
      "-p",
      `${PG_PORT}:5432`,
      "postgres:17-alpine",
    ]);
    assertEquals(run.code, 0, run.out);

    // Wait until host-port TCP accepts queries (pg_isready can pass mid-initdb).
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        await psql("SELECT 1;");
        ready = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    assert(ready, "ephemeral Postgres did not become ready on host port");

    await psql(`
CREATE TABLE trips (
  id uuid PRIMARY KEY,
  scheduled_status text,
  status text,
  confirmed_driver_id uuid,
  driver_id uuid,
  completed_at timestamptz,
  scheduled_hold_reason text,
  scheduled_ack_status text,
  scheduled_ack_deadline_at timestamptz,
  scheduled_ack_driver_id uuid,
  scheduled_ack_nonce uuid,
  scheduled_ack_acknowledged_at timestamptz,
  scheduled_ack_resolved_at timestamptz,
  scheduled_ack_resolution_reason text,
  excluded_driver_ids uuid[] DEFAULT '{}',
  payment_gate_blocked boolean DEFAULT false
);

CREATE OR REPLACE FUNCTION try_arm_ack(p_id uuid, p_driver uuid, p_deadline timestamptz, p_nonce uuid)
RETURNS text AS $$
DECLARE n int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_id::text));
  UPDATE trips SET
    scheduled_status='awaiting_activation_accept',
    scheduled_ack_status='pending',
    scheduled_ack_deadline_at=p_deadline,
    scheduled_ack_driver_id=p_driver,
    scheduled_ack_nonce=p_nonce,
    scheduled_ack_acknowledged_at=NULL,
    scheduled_ack_resolved_at=NULL,
    scheduled_ack_resolution_reason=NULL
  WHERE id=p_id AND completed_at IS NULL AND driver_id IS NULL
    AND confirmed_driver_id=p_driver
    AND scheduled_status IN ('driver_assigned','scheduled','scheduled_committed')
    AND COALESCE(scheduled_hold_reason,'') NOT IN ('admin_exceptional','manual','airport_pricing')
    AND COALESCE(payment_gate_blocked,false)=false;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n=1 THEN RETURN 'ARMED'; END IF;
  RETURN 'CAS_MISS';
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION try_heading_to_pickup(p_id uuid, p_driver uuid, p_now timestamptz)
RETURNS text AS $$
DECLARE n int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_id::text));
  UPDATE trips SET
    driver_id=p_driver,
    status='en_route_to_pickup',
    scheduled_status='driver_en_route',
    scheduled_ack_status='acknowledged',
    scheduled_ack_acknowledged_at=p_now,
    scheduled_ack_resolved_at=p_now,
    scheduled_ack_resolution_reason='heading_to_pickup'
  WHERE id=p_id AND completed_at IS NULL AND driver_id IS NULL
    AND confirmed_driver_id=p_driver
    AND scheduled_status='awaiting_activation_accept'
    AND scheduled_ack_status='pending'
    AND scheduled_ack_deadline_at > p_now
    AND COALESCE(scheduled_ack_driver_id, p_driver)=p_driver
    AND COALESCE(payment_gate_blocked,false)=false;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n=1 THEN RETURN 'ACKED'; END IF;
  RETURN 'CAS_MISS';
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION try_ack_timeout(p_id uuid, p_driver uuid, p_now timestamptz)
RETURNS text AS $$
DECLARE n int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_id::text));
  UPDATE trips SET
    scheduled_status='converted_to_instant',
    status='searching',
    confirmed_driver_id=NULL,
    driver_id=NULL,
    scheduled_ack_status='timed_out',
    scheduled_ack_resolved_at=p_now,
    scheduled_ack_resolution_reason='acknowledgement_timeout',
    excluded_driver_ids = CASE
      WHEN p_driver IS NULL THEN excluded_driver_ids
      ELSE array_append(excluded_driver_ids, p_driver)
    END
  WHERE id=p_id AND completed_at IS NULL AND driver_id IS NULL
    AND scheduled_status='awaiting_activation_accept'
    AND scheduled_ack_status='pending'
    AND scheduled_ack_deadline_at <= p_now;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n=1 THEN RETURN 'TIMED_OUT'; END IF;
  RETURN 'CAS_MISS';
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION try_cancel_booking(p_id uuid, p_driver uuid, p_now timestamptz)
RETURNS text AS $$
DECLARE n int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_id::text));
  UPDATE trips SET
    scheduled_status='converted_to_instant',
    status='searching',
    confirmed_driver_id=NULL,
    driver_id=NULL,
    scheduled_ack_status='cancelled',
    scheduled_ack_resolved_at=p_now,
    scheduled_ack_resolution_reason='departure_ack_cancelled_by_driver',
    excluded_driver_ids = array_append(excluded_driver_ids, p_driver)
  WHERE id=p_id AND completed_at IS NULL AND driver_id IS NULL
    AND confirmed_driver_id=p_driver
    AND scheduled_status='awaiting_activation_accept'
    AND scheduled_ack_status='pending';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n=1 THEN RETURN 'CANCELLED'; END IF;
  RETURN 'CAS_MISS';
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION try_reassign(p_id uuid, p_new uuid)
RETURNS text AS $$
DECLARE n int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_id::text));
  UPDATE trips SET
    confirmed_driver_id=p_new,
    scheduled_status='driver_assigned',
    scheduled_ack_status='superseded',
    scheduled_ack_resolved_at=now(),
    scheduled_ack_resolution_reason='reassigned'
  WHERE id=p_id AND completed_at IS NULL AND driver_id IS NULL
    AND scheduled_status IN ('awaiting_activation_accept','driver_assigned','scheduled');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n=1 THEN RETURN 'REASSIGNED'; END IF;
  RETURN 'CAS_MISS';
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION try_payment_block(p_id uuid)
RETURNS text AS $$
DECLARE n int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_id::text));
  UPDATE trips SET payment_gate_blocked=true, scheduled_status='payment_gate_blocked'
  WHERE id=p_id AND driver_id IS NULL
    AND scheduled_status IN ('awaiting_activation_accept','driver_assigned','scheduled');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n=1 THEN RETURN 'PAYMENT_BLOCKED'; END IF;
  RETURN 'CAS_MISS';
END; $$ LANGUAGE plpgsql;
`);

    const reset = async () => {
      await psql(`
DELETE FROM trips WHERE id='${TRIP}'::uuid;
INSERT INTO trips (id, scheduled_status, status, confirmed_driver_id, driver_id)
VALUES ('${TRIP}'::uuid, 'driver_assigned', 'scheduled', '${D1}'::uuid, NULL);
`);
    };

    // 1) Concurrent arm — one winner
    await reset();
    const deadlineFuture = "2026-11-12T19:35:45.000Z";
    const [arm1, arm2] = await Promise.all([
      psql(
        `SELECT try_arm_ack('${TRIP}'::uuid,'${D1}'::uuid,'${deadlineFuture}'::timestamptz,'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid);`,
      ),
      psql(
        `SELECT try_arm_ack('${TRIP}'::uuid,'${D1}'::uuid,'${deadlineFuture}'::timestamptz,'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid);`,
      ),
    ]);
    assert([arm1, arm2].includes("ARMED"));
    assert([arm1, arm2].includes("CAS_MISS"));

    // 2) Heading to Pickup vs timeout — exactly one outcome
    await reset();
    await psql(
      `SELECT try_arm_ack('${TRIP}'::uuid,'${D1}'::uuid,'2026-11-12T19:35:00.000Z'::timestamptz,'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid);`,
    );
    const [ackVsTo1, ackVsTo2] = await Promise.all([
      psql(
        `SELECT try_heading_to_pickup('${TRIP}'::uuid,'${D1}'::uuid,'2026-11-12T19:34:59.000Z'::timestamptz);`,
      ),
      psql(
        `SELECT try_ack_timeout('${TRIP}'::uuid,'${D1}'::uuid,'2026-11-12T19:35:00.000Z'::timestamptz);`,
      ),
    ]);
    // Depending on lock order: either ACKED+CAS_MISS or TIMED_OUT+CAS_MISS
    assert(
      ([ackVsTo1, ackVsTo2].includes("ACKED") &&
        [ackVsTo1, ackVsTo2].includes("CAS_MISS")) ||
        ([ackVsTo1, ackVsTo2].includes("TIMED_OUT") &&
          [ackVsTo1, ackVsTo2].includes("CAS_MISS")),
    );
    const driversAfter = await psql(
      `SELECT COUNT(*)::text FROM trips WHERE id='${TRIP}'::uuid AND driver_id IS NOT NULL AND confirmed_driver_id IS NOT NULL AND driver_id<>confirmed_driver_id;`,
    );
    assertEquals(driversAfter, "0");

    // 3) Late Heading to Pickup at/after deadline rejected
    await reset();
    await psql(
      `SELECT try_arm_ack('${TRIP}'::uuid,'${D1}'::uuid,'2026-11-12T19:35:00.000Z'::timestamptz,'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid);`,
    );
    assertEquals(
      await psql(
        `SELECT try_heading_to_pickup('${TRIP}'::uuid,'${D1}'::uuid,'2026-11-12T19:35:00.000Z'::timestamptz);`,
      ),
      "CAS_MISS",
    );
    assertEquals(
      await psql(
        `SELECT try_ack_timeout('${TRIP}'::uuid,'${D1}'::uuid,'2026-11-12T19:35:00.000Z'::timestamptz);`,
      ),
      "TIMED_OUT",
    );

    // 4) Heading to Pickup vs Cancel Booking — one winner
    await reset();
    await psql(
      `SELECT try_arm_ack('${TRIP}'::uuid,'${D1}'::uuid,'${deadlineFuture}'::timestamptz,'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid);`,
    );
    const [ackVsCancel1, ackVsCancel2] = await Promise.all([
      psql(
        `SELECT try_heading_to_pickup('${TRIP}'::uuid,'${D1}'::uuid,'2026-11-12T19:35:10.000Z'::timestamptz);`,
      ),
      psql(
        `SELECT try_cancel_booking('${TRIP}'::uuid,'${D1}'::uuid,'2026-11-12T19:35:10.000Z'::timestamptz);`,
      ),
    ]);
    assert(
      ([ackVsCancel1, ackVsCancel2].includes("ACKED") &&
        [ackVsCancel1, ackVsCancel2].includes("CAS_MISS")) ||
        ([ackVsCancel1, ackVsCancel2].includes("CANCELLED") &&
          [ackVsCancel1, ackVsCancel2].includes("CAS_MISS")),
    );

    // 5) Cancel vs timeout — one winner
    await reset();
    await psql(
      `SELECT try_arm_ack('${TRIP}'::uuid,'${D1}'::uuid,'2026-11-12T19:35:00.000Z'::timestamptz,'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid);`,
    );
    const [c1, t1] = await Promise.all([
      psql(
        `SELECT try_cancel_booking('${TRIP}'::uuid,'${D1}'::uuid,'2026-11-12T19:35:00.000Z'::timestamptz);`,
      ),
      psql(
        `SELECT try_ack_timeout('${TRIP}'::uuid,'${D1}'::uuid,'2026-11-12T19:35:00.000Z'::timestamptz);`,
      ),
    ]);
    assert(
      ([c1, t1].includes("CANCELLED") && [c1, t1].includes("CAS_MISS")) ||
        ([c1, t1].includes("TIMED_OUT") && [c1, t1].includes("CAS_MISS")),
    );

    // 6) Duplicate acknowledgement from two devices — one ACKED
    await reset();
    await psql(
      `SELECT try_arm_ack('${TRIP}'::uuid,'${D1}'::uuid,'${deadlineFuture}'::timestamptz,'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid);`,
    );
    const [dAck1, dAck2] = await Promise.all([
      psql(
        `SELECT try_heading_to_pickup('${TRIP}'::uuid,'${D1}'::uuid,'2026-11-12T19:35:10.000Z'::timestamptz);`,
      ),
      psql(
        `SELECT try_heading_to_pickup('${TRIP}'::uuid,'${D1}'::uuid,'2026-11-12T19:35:10.000Z'::timestamptz);`,
      ),
    ]);
    assertEquals([dAck1, dAck2].filter((x) => x === "ACKED").length, 1);
    assertEquals([dAck1, dAck2].filter((x) => x === "CAS_MISS").length, 1);

    // 7) Reassignment supersedes stale acknowledgement
    await reset();
    await psql(
      `SELECT try_arm_ack('${TRIP}'::uuid,'${D1}'::uuid,'${deadlineFuture}'::timestamptz,'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid);`,
    );
    assertEquals(
      await psql(`SELECT try_reassign('${TRIP}'::uuid,'${D2}'::uuid);`),
      "REASSIGNED",
    );
    assertEquals(
      await psql(
        `SELECT try_heading_to_pickup('${TRIP}'::uuid,'${D1}'::uuid,'2026-11-12T19:35:10.000Z'::timestamptz);`,
      ),
      "CAS_MISS",
    );
    const conf = await psql(
      `SELECT confirmed_driver_id::text FROM trips WHERE id='${TRIP}'::uuid;`,
    );
    assertEquals(conf, D2);

    // 8) Payment block vs acknowledgement — payment wins or ack wins, never both live
    await reset();
    await psql(
      `SELECT try_arm_ack('${TRIP}'::uuid,'${D1}'::uuid,'${deadlineFuture}'::timestamptz,'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid);`,
    );
    const [pay, ackPay] = await Promise.all([
      psql(`SELECT try_payment_block('${TRIP}'::uuid);`),
      psql(
        `SELECT try_heading_to_pickup('${TRIP}'::uuid,'${D1}'::uuid,'2026-11-12T19:35:10.000Z'::timestamptz);`,
      ),
    ]);
    assert(
      ([pay, ackPay].includes("PAYMENT_BLOCKED") &&
        [pay, ackPay].includes("CAS_MISS")) ||
        ([pay, ackPay].includes("ACKED") && [pay, ackPay].includes("CAS_MISS")),
    );
    const dual = await psql(
      `SELECT COUNT(*)::text FROM trips WHERE id='${TRIP}'::uuid AND scheduled_status='driver_en_route' AND payment_gate_blocked=true;`,
    );
    assertEquals(dual, "0");

    // No duplicate conversion markers
    await reset();
    await psql(
      `SELECT try_arm_ack('${TRIP}'::uuid,'${D1}'::uuid,'2026-11-12T19:35:00.000Z'::timestamptz,'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid);`,
    );
    const [toA, toB] = await Promise.all([
      psql(
        `SELECT try_ack_timeout('${TRIP}'::uuid,'${D1}'::uuid,'2026-11-12T19:35:00.000Z'::timestamptz);`,
      ),
      psql(
        `SELECT try_ack_timeout('${TRIP}'::uuid,'${D1}'::uuid,'2026-11-12T19:35:00.000Z'::timestamptz);`,
      ),
    ]);
    assertEquals([toA, toB].filter((x) => x === "TIMED_OUT").length, 1);

    await sh(["docker", "rm", "-f", "p5-ack-pg"]);
  },
});
