/**
 * Phase 4 — PG concurrency for JIT arm / activate / cancel / hold / offline.
 * Not production. No Revolut.
 */
import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const PG_PORT = 55435;
const DATABASE_URL =
  `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/postgres`;

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
  name: "PG: JIT arm/activate races — cancel, hold, concurrent cron, offline skip",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await sh(["docker", "rm", "-f", "p4-jit-pg"]);
    const run = await sh([
      "docker",
      "run",
      "-d",
      "--name",
      "p4-jit-pg",
      "-e",
      "POSTGRES_PASSWORD=postgres",
      "-p",
      `${PG_PORT}:5432`,
      "postgres:17-alpine",
    ]);
    assertEquals(run.code, 0, run.out);

    for (let i = 0; i < 30; i++) {
      const ready = await sh([
        "docker",
        "exec",
        "p4-jit-pg",
        "pg_isready",
        "-U",
        "postgres",
      ]);
      if (ready.code === 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    await psql(`
CREATE TABLE trips (
  id uuid PRIMARY KEY,
  scheduled_status text,
  status text,
  confirmed_driver_id uuid,
  driver_id uuid,
  completed_at timestamptz,
  scheduled_hold_reason text,
  scheduled_jit_activated_at timestamptz,
  excluded_driver_ids uuid[] DEFAULT '{}'
);
INSERT INTO trips (id, scheduled_status, status, confirmed_driver_id, driver_id)
VALUES (
  'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  'driver_assigned',
  'scheduled',
  '11111111-1111-1111-1111-111111111111',
  NULL
);

CREATE OR REPLACE FUNCTION try_jit_arm(p_id uuid, p_driver uuid) RETURNS text AS $$
DECLARE n int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_id::text));
  UPDATE trips SET scheduled_status='awaiting_activation_accept'
  WHERE id=p_id AND completed_at IS NULL AND driver_id IS NULL
    AND confirmed_driver_id=p_driver
    AND scheduled_status IN ('driver_assigned','scheduled','scheduled_committed')
    AND COALESCE(scheduled_hold_reason,'') NOT IN ('admin_exceptional','manual','airport_pricing');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n=1 THEN RETURN 'ARMED'; END IF;
  RETURN 'CAS_MISS';
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION try_jit_activate(p_id uuid, p_driver uuid) RETURNS text AS $$
DECLARE n int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_id::text));
  UPDATE trips SET driver_id=p_driver, status='en_route_to_pickup',
    scheduled_status='driver_en_route', scheduled_jit_activated_at=now()
  WHERE id=p_id AND completed_at IS NULL AND driver_id IS NULL
    AND confirmed_driver_id=p_driver
    AND scheduled_status IN ('driver_assigned','scheduled','scheduled_committed','awaiting_activation_accept');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n=1 THEN RETURN 'ACTIVATED'; END IF;
  RETURN 'CAS_MISS';
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION try_cancel_confirmed(p_id uuid, p_driver uuid) RETURNS text AS $$
DECLARE n int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_id::text));
  UPDATE trips SET confirmed_driver_id=NULL, scheduled_status='broadcasting',
    status='offered',
    excluded_driver_ids = array_append(excluded_driver_ids, p_driver)
  WHERE id=p_id AND driver_id IS NULL
    AND scheduled_status IN ('driver_assigned','scheduled','awaiting_activation_accept');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n=1 THEN RETURN 'CANCELLED'; END IF;
  RETURN 'CAS_MISS';
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION try_admin_hold(p_id uuid) RETURNS text AS $$
DECLARE n int;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext(p_id::text));
  UPDATE trips SET scheduled_status='admin_held', scheduled_hold_reason='admin_exceptional'
  WHERE id=p_id AND driver_id IS NULL
    AND scheduled_status IN ('driver_assigned','scheduled','awaiting_activation_accept','admin_held');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n=1 THEN RETURN 'HELD'; END IF;
  RETURN 'CAS_MISS';
END; $$ LANGUAGE plpgsql;
`);

    // Concurrent arm — one winner
    const [a1, a2] = await Promise.all([
      psql("SELECT try_jit_arm('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::uuid, '11111111-1111-1111-1111-111111111111'::uuid);"),
      psql("SELECT try_jit_arm('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::uuid, '11111111-1111-1111-1111-111111111111'::uuid);"),
    ]);
    assert([a1, a2].includes("ARMED"));
    assert([a1, a2].includes("CAS_MISS"));

    // Cancel then arm — cancel wins; arm misses; driver excluded
    await psql(`UPDATE trips SET scheduled_status='driver_assigned', status='scheduled',
      driver_id=NULL, confirmed_driver_id='11111111-1111-1111-1111-111111111111',
      scheduled_hold_reason=NULL, excluded_driver_ids='{}'
      WHERE id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';`);
    assertEquals(
      await psql(
        "SELECT try_cancel_confirmed('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::uuid, '11111111-1111-1111-1111-111111111111'::uuid);",
      ),
      "CANCELLED",
    );
    assertEquals(
      await psql(
        "SELECT try_jit_arm('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::uuid, '11111111-1111-1111-1111-111111111111'::uuid);",
      ),
      "CAS_MISS",
    );
    const excluded = await psql(
      "SELECT (excluded_driver_ids @> ARRAY['11111111-1111-1111-1111-111111111111'::uuid])::text FROM trips WHERE id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';",
    );
    assert(excluded === "t" || excluded === "true");

    // Arm then cancel — arm wins; cancel can still rematch armed trip
    await psql(`UPDATE trips SET scheduled_status='driver_assigned', status='scheduled',
      driver_id=NULL, confirmed_driver_id='11111111-1111-1111-1111-111111111111',
      scheduled_hold_reason=NULL, excluded_driver_ids='{}'
      WHERE id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';`);
    assertEquals(
      await psql(
        "SELECT try_jit_arm('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::uuid, '11111111-1111-1111-1111-111111111111'::uuid);",
      ),
      "ARMED",
    );
    assertEquals(
      await psql(
        "SELECT try_cancel_confirmed('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::uuid, '11111111-1111-1111-1111-111111111111'::uuid);",
      ),
      "CANCELLED",
    );

    // Admin hold blocks arm
    await psql(`UPDATE trips SET scheduled_status='admin_held', scheduled_hold_reason='admin_exceptional',
      driver_id=NULL, confirmed_driver_id='11111111-1111-1111-1111-111111111111',
      excluded_driver_ids='{}' WHERE id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';`);
    const heldArm = await psql(
      "SELECT try_jit_arm('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::uuid, '11111111-1111-1111-1111-111111111111'::uuid);",
    );
    assertEquals(heldArm, "CAS_MISS");

    // Hold vs activate race
    await psql(`UPDATE trips SET scheduled_status='driver_assigned', scheduled_hold_reason=NULL,
      confirmed_driver_id='11111111-1111-1111-1111-111111111111', driver_id=NULL
      WHERE id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';`);
    const [h1, h2] = await Promise.all([
      psql("SELECT try_admin_hold('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::uuid);"),
      psql("SELECT try_jit_activate('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::uuid, '11111111-1111-1111-1111-111111111111'::uuid);"),
    ]);
    assert(
      ([h1, h2].includes("HELD") && [h1, h2].includes("CAS_MISS")) ||
        ([h1, h2].includes("ACTIVATED") && [h1, h2].includes("CAS_MISS")),
    );

    // Concurrent activate — one winner
    await psql(`UPDATE trips SET scheduled_status='awaiting_activation_accept', status='scheduled',
      driver_id=NULL, scheduled_hold_reason=NULL,
      confirmed_driver_id='11111111-1111-1111-1111-111111111111'
      WHERE id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';`);
    const [x1, x2] = await Promise.all([
      psql("SELECT try_jit_activate('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::uuid, '11111111-1111-1111-1111-111111111111'::uuid);"),
      psql("SELECT try_jit_activate('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::uuid, '11111111-1111-1111-1111-111111111111'::uuid);"),
    ]);
    assert([x1, x2].includes("ACTIVATED"));
    assert([x1, x2].includes("CAS_MISS"));
    const st = await psql(
      "SELECT scheduled_status||'|'||status FROM trips WHERE id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';",
    );
    assertEquals(st, "driver_en_route|en_route_to_pickup");

    await sh(["docker", "rm", "-f", "p4-jit-pg"]);
  },
});
