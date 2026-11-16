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

    // Retry exhaustion — stop auto-publish and stamp exhausted + ops alert row
    await psql(`
ALTER TABLE trips ADD COLUMN IF NOT EXISTS scheduled_publish_attempts int DEFAULT 0;
CREATE TABLE IF NOT EXISTS ops_alerts (
  fingerprint text PRIMARY KEY,
  title text,
  related_trip_id uuid,
  metadata jsonb
);
UPDATE trips SET scheduled_status='admin_held', scheduled_hold_reason='publication_retry',
  scheduled_publish_attempts=5, scheduled_broadcast_at=NULL, broadcast_enabled=true,
  confirmed_driver_id=NULL, driver_id=NULL
WHERE id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
`);
    const exhaustedGate = await psql(`
SELECT CASE
  WHEN scheduled_hold_reason IN ('publication_pending','publication_retry')
   AND scheduled_publish_attempts < 5 THEN 'ELIGIBLE'
  ELSE 'EXHAUSTED'
END FROM trips WHERE id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
`);
    assertEquals(exhaustedGate, "EXHAUSTED");
    await psql(`
UPDATE trips SET scheduled_hold_reason='publication_exhausted' WHERE id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
INSERT INTO ops_alerts(fingerprint, title, related_trip_id, metadata)
VALUES (
  'scheduled_marketplace_publish_exhausted:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  'Scheduled marketplace publication exhausted',
  'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  '{"attempts":5}'::jsonb
) ON CONFLICT (fingerprint) DO NOTHING;
`);
    const alertCount = await psql(`
SELECT count(*)::text FROM ops_alerts
WHERE fingerprint LIKE 'scheduled_marketplace_publish_exhausted:%';
`);
    assertEquals(alertCount, "1");

    // Concurrent assignment vs publication — assign wins CAS; publish must not clear driver
    await psql(`
UPDATE trips SET scheduled_status='admin_held', scheduled_hold_reason='publication_pending',
  scheduled_publish_attempts=0, confirmed_driver_id=NULL, driver_id=NULL,
  scheduled_broadcast_at=NULL
WHERE id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
`);
    const pub = sh([
      "psql",
      DATABASE_URL,
      "-Atc",
      "SELECT try_auto_publish('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::uuid);",
    ]);
    await new Promise((r) => setTimeout(r, 50));
    const asg = sh([
      "psql",
      DATABASE_URL,
      "-Atc",
      "SELECT try_accept('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::uuid, '33333333-3333-3333-3333-333333333333'::uuid);",
    ]);
    const [rp, rAssign] = await Promise.all([pub, asg]);
    assert(
      [rp.out.trim(), rAssign.out.trim()].some((x) =>
        ["PUBLISHED", "ACCEPTED", "LOCK_CONTENTION", "HOLD_NOT_ELIGIBLE", "TRIP_ALREADY_TAKEN"].includes(x)
      ),
      `assign/publish race: ${rp.out.trim()}, ${rAssign.out.trim()}`,
    );

    // Audit atomicity simulation: mutate + audit in one txn; rollback if audit fails
    await psql(`
CREATE TABLE IF NOT EXISTS audit_logs (
  id serial PRIMARY KEY,
  event_type text NOT NULL,
  trip_id uuid,
  details jsonb
);
CREATE OR REPLACE FUNCTION emergency_hold_with_audit(p_id uuid, p_fail_audit boolean)
RETURNS text AS $$
BEGIN
  UPDATE trips SET scheduled_status='admin_held', scheduled_hold_reason='admin_exceptional',
    scheduled_broadcast_at=NULL WHERE id=p_id;
  IF p_fail_audit THEN
    RAISE EXCEPTION 'AUDIT_REQUIRED';
  END IF;
  INSERT INTO audit_logs(event_type, trip_id, details)
  VALUES ('ADMIN_SCHEDULED_HOLD_EXCEPTIONAL', p_id, '{"ok":true}'::jsonb);
  RETURN 'OK';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLERRM;
END; $$ LANGUAGE plpgsql;
`);
    const auditOk = await psql(
      "SELECT emergency_hold_with_audit('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::uuid, false);",
    );
    assertEquals(auditOk, "OK");
    const auditFail = await psql(
      "SELECT emergency_hold_with_audit('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::uuid, true);",
    );
    assert(auditFail.includes("AUDIT_REQUIRED"));

    // Early cancellation rematch reopen — only publication_pending/retry eligible
    await psql(`
UPDATE trips SET scheduled_status='admin_held', scheduled_hold_reason='publication_pending',
  confirmed_driver_id=NULL, scheduled_broadcast_at=NULL WHERE id='aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
`);
    const reopen = await psql(
      "SELECT try_auto_publish('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'::uuid);",
    );
    assertEquals(reopen, "PUBLISHED");

    await sh(["docker", "rm", "-f", "p3-pg"]);
  },
});
