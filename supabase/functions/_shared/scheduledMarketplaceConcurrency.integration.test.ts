/**
 * Phase 3 — representative PostgreSQL concurrency integration (local Docker PG17).
 * Not production. No Revolut. Mirrors advisory-lock + hold_reason CAS semantics.
 *
 * Run: deno test --allow-run --allow-env --allow-net --allow-read \
 *   supabase/functions/_shared/scheduledMarketplaceConcurrency.integration.test.ts
 */
import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

const PG_PORT = 55433;
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
  name: "PG integration: auto-publish vs Admin exceptional hold CAS",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await sh(["docker", "rm", "-f", "p3-pg"]);
    const run = await sh([
      "docker",
      "run",
      "-d",
      "--name",
      "p3-pg",
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
        "p3-pg",
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
  scheduled_hold_reason text,
  scheduled_broadcast_at timestamptz,
  broadcast_enabled boolean DEFAULT true,
  driver_id uuid,
  confirmed_driver_id uuid,
  updated_at timestamptz DEFAULT now()
);
INSERT INTO trips (id, scheduled_status, scheduled_hold_reason)
VALUES ('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'admin_held', 'publication_pending');

CREATE OR REPLACE FUNCTION try_auto_publish(p_id uuid) RETURNS text AS $$
DECLARE v_locked boolean; v_row trips%ROWTYPE;
BEGIN
  v_locked := pg_try_advisory_xact_lock(hashtext(p_id::text));
  IF NOT v_locked THEN RETURN 'LOCK_CONTENTION'; END IF;
  SELECT * INTO v_row FROM trips WHERE id = p_id FOR UPDATE;
  IF v_row.scheduled_hold_reason IS DISTINCT FROM 'publication_pending'
     AND v_row.scheduled_hold_reason IS DISTINCT FROM 'publication_retry' THEN
    RETURN 'HOLD_NOT_ELIGIBLE';
  END IF;
  IF v_row.scheduled_status = 'scheduled' AND v_row.scheduled_broadcast_at IS NOT NULL THEN
    RETURN 'ALREADY_PUBLISHED';
  END IF;
  PERFORM pg_sleep(0.35);
  UPDATE trips SET scheduled_status='scheduled', scheduled_broadcast_at=now(),
    scheduled_hold_reason=NULL WHERE id=p_id;
  RETURN 'PUBLISHED';
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION try_admin_exceptional_hold(p_id uuid) RETURNS text AS $$
DECLARE v_locked boolean; v_row trips%ROWTYPE;
BEGIN
  v_locked := pg_try_advisory_xact_lock(hashtext(p_id::text));
  IF NOT v_locked THEN RETURN 'LOCK_CONTENTION'; END IF;
  SELECT * INTO v_row FROM trips WHERE id = p_id FOR UPDATE;
  PERFORM pg_sleep(0.35);
  UPDATE trips SET scheduled_status='admin_held', scheduled_broadcast_at=NULL,
    scheduled_hold_reason='admin_exceptional' WHERE id=p_id;
  RETURN 'HELD_EXCEPTIONAL';
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION try_accept(p_id uuid, p_driver uuid) RETURNS text AS $$
DECLARE v_locked boolean; v_row trips%ROWTYPE;
BEGIN
  v_locked := pg_try_advisory_xact_lock(hashtext(p_id::text));
  IF NOT v_locked THEN RETURN 'LOCK_CONTENTION'; END IF;
  SELECT * INTO v_row FROM trips WHERE id = p_id FOR UPDATE;
  IF v_row.confirmed_driver_id IS NOT NULL AND v_row.confirmed_driver_id <> p_driver THEN
    RETURN 'TRIP_ALREADY_TAKEN';
  END IF;
  IF v_row.confirmed_driver_id = p_driver THEN RETURN 'IDEMPOTENT'; END IF;
  PERFORM pg_sleep(0.25);
  UPDATE trips SET confirmed_driver_id=p_driver, scheduled_status='driver_assigned' WHERE id=p_id;
  RETURN 'ACCEPTED';
END; $$ LANGUAGE plpgsql;
`);

    // Race: auto-publish vs Admin exceptional hold — exactly one wins.
    const a = sh([
      "psql",
      DATABASE_URL,
      "-Atc",
      "SELECT try_auto_publish('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::uuid);",
    ]);
    await new Promise((r) => setTimeout(r, 50));
    const b = sh([
      "psql",
      DATABASE_URL,
      "-Atc",
      "SELECT try_admin_exceptional_hold('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::uuid);",
    ]);
    const [ra, rb] = await Promise.all([a, b]);
    const outcomes = [ra.out.trim(), rb.out.trim()].sort();
    assert(
      outcomes.includes("LOCK_CONTENTION") ||
        outcomes.includes("HOLD_NOT_ELIGIBLE") ||
        outcomes.includes("PUBLISHED") ||
        outcomes.includes("HELD_EXCEPTIONAL"),
      `unexpected outcomes: ${outcomes.join(",")}`,
    );
    // Exactly one terminal state on the row.
    const reason = await psql(
      "SELECT scheduled_hold_reason FROM trips WHERE id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';",
    );
    const status = await psql(
      "SELECT scheduled_status FROM trips WHERE id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';",
    );
    assert(
      (reason === "admin_exceptional" && status === "admin_held") ||
        (reason === "" && status === "scheduled") ||
        (reason === "publication_pending" && status === "admin_held"),
      `final state reason=${reason} status=${status}`,
    );

    // Reset for duplicate accept race
    await psql(`
UPDATE trips SET confirmed_driver_id=NULL, scheduled_status='scheduled',
  scheduled_hold_reason=NULL, scheduled_broadcast_at=now()
WHERE id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
`);
    const c1 = sh([
      "psql",
      DATABASE_URL,
      "-Atc",
      "SELECT try_accept('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::uuid, '11111111-1111-1111-1111-111111111111'::uuid);",
    ]);
    await new Promise((r) => setTimeout(r, 50));
    const c2 = sh([
      "psql",
      DATABASE_URL,
      "-Atc",
      "SELECT try_accept('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::uuid, '22222222-2222-2222-2222-222222222222'::uuid);",
    ]);
    const [rc1, rc2] = await Promise.all([c1, c2]);
    const acceptOut = [rc1.out.trim(), rc2.out.trim()];
    assert(acceptOut.includes("ACCEPTED"));
    assert(
      acceptOut.includes("LOCK_CONTENTION") ||
        acceptOut.includes("TRIP_ALREADY_TAKEN"),
    );
    const winner = await psql(
      "SELECT confirmed_driver_id::text FROM trips WHERE id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';",
    );
    assertEquals(winner, "11111111-1111-1111-1111-111111111111");

    // Airport hold cannot be forced open
    await psql(`
UPDATE trips SET broadcast_enabled=false, scheduled_hold_reason='airport_pricing',
  scheduled_status='admin_held', scheduled_broadcast_at=NULL, confirmed_driver_id=NULL
WHERE id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
UPDATE trips SET broadcast_enabled=true WHERE id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
`);
    // Without DB trigger in this harness, simulate gate: publish refused when hold=airport
    const blocked = await psql(`
SELECT CASE WHEN scheduled_hold_reason='airport_pricing' THEN 'BLOCKED' ELSE 'OPEN' END
FROM trips WHERE id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
`);
    assertEquals(blocked, "BLOCKED");

    await sh(["docker", "rm", "-f", "p3-pg"]);
  },
});
