/**
 * Mandatory checkpoint: emergency mutate + audit in ONE PostgreSQL transaction.
 * Audit failure must leave trip state unchanged (no compensate-after-commit).
 */
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

const PG_PORT = 55434;
const DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${PG_PORT}/postgres`;

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
  name: "PG: emergency mutate+audit atomic — audit failure leaves trip unchanged",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    await sh(["docker", "rm", "-f", "p3-audit-pg"]);
    const run = await sh([
      "docker",
      "run",
      "-d",
      "--name",
      "p3-audit-pg",
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
        "p3-audit-pg",
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
  pending_release_kind text,
  confirmed_driver_id uuid,
  driver_id uuid,
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE audit_logs (
  id serial PRIMARY KEY,
  event_type text NOT NULL,
  user_id uuid,
  trip_id uuid,
  details jsonb
);

INSERT INTO trips (id, scheduled_status, scheduled_hold_reason, scheduled_broadcast_at)
VALUES (
  'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  'admin_held',
  'publication_pending',
  NULL
);

-- Mirrors admin_scheduled_emergency_mutate: UPDATE then INSERT audit in one fn.
CREATE OR REPLACE FUNCTION emergency_hold_atomic(p_id uuid, p_actor uuid, p_fail_audit boolean)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  v_prev text;
BEGIN
  SELECT scheduled_hold_reason INTO v_prev FROM trips WHERE id = p_id FOR UPDATE;

  UPDATE trips SET
    scheduled_status = 'admin_held',
    scheduled_broadcast_at = NULL,
    scheduled_hold_reason = 'admin_exceptional',
    pending_release_kind = NULL,
    updated_at = now()
  WHERE id = p_id;

  IF p_fail_audit THEN
    RAISE EXCEPTION 'AUDIT_REQUIRED: simulated audit_logs failure';
  END IF;

  INSERT INTO audit_logs(event_type, user_id, trip_id, details)
  VALUES (
    'ADMIN_SCHEDULED_HOLD_EXCEPTIONAL',
    p_actor,
    p_id,
    jsonb_build_object('previous_hold', v_prev, 'resulting_hold', 'admin_exceptional')
  );

  RETURN 'OK';
EXCEPTION WHEN OTHERS THEN
  -- Propagate so the calling statement aborts the transaction.
  RAISE;
END;
$$;

CREATE OR REPLACE FUNCTION emergency_make_available_atomic(p_id uuid, p_actor uuid, p_fail_audit boolean)
RETURNS text
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE trips SET
    scheduled_status = 'scheduled',
    scheduled_broadcast_at = now(),
    scheduled_hold_reason = NULL,
    updated_at = now()
  WHERE id = p_id
    AND scheduled_status IN ('admin_held', 'scheduled', 'pending')
    AND confirmed_driver_id IS NULL
    AND driver_id IS NULL;

  IF p_fail_audit THEN
    RAISE EXCEPTION 'AUDIT_REQUIRED: simulated audit_logs failure';
  END IF;

  INSERT INTO audit_logs(event_type, user_id, trip_id, details)
  VALUES ('ADMIN_SCHEDULED_MAKE_AVAILABLE_NOW', p_actor, p_id, '{}'::jsonb);
  RETURN 'OK';
END;
$$;

CREATE OR REPLACE FUNCTION emergency_assign_atomic(p_id uuid, p_driver uuid, p_actor uuid, p_fail_audit boolean)
RETURNS text
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE trips SET
    confirmed_driver_id = p_driver,
    scheduled_status = 'driver_assigned',
    updated_at = now()
  WHERE id = p_id AND driver_id IS NULL;

  IF p_fail_audit THEN
    RAISE EXCEPTION 'AUDIT_REQUIRED: simulated audit_logs failure';
  END IF;

  INSERT INTO audit_logs(event_type, user_id, trip_id, details)
  VALUES ('ADMIN_SCHEDULED_ASSIGN_NOW', p_actor, p_id, jsonb_build_object('driver', p_driver));
  RETURN 'OK';
END;
$$;
`);

    const actor = "11111111-1111-1111-1111-111111111111";
    const trip = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

    // Success path: hold + audit both commit.
    const ok = await psql(
      `SELECT emergency_hold_atomic('${trip}'::uuid, '${actor}'::uuid, false);`,
    );
    assertEquals(ok, "OK");
    assertEquals(
      await psql(`SELECT scheduled_hold_reason FROM trips WHERE id='${trip}';`),
      "admin_exceptional",
    );
    assertEquals(
      await psql(`SELECT count(*)::text FROM audit_logs WHERE trip_id='${trip}';`),
      "1",
    );

    // Reset for failure path.
    await psql(`
UPDATE trips SET scheduled_status='admin_held', scheduled_hold_reason='publication_pending',
  scheduled_broadcast_at=NULL, confirmed_driver_id=NULL WHERE id='${trip}';
DELETE FROM audit_logs;
`);

    // Audit failure inside same transaction → trip unchanged.
    const fail = await sh([
      "psql",
      DATABASE_URL,
      "-v",
      "ON_ERROR_STOP=1",
      "-Atc",
      `BEGIN; SELECT emergency_hold_atomic('${trip}'::uuid, '${actor}'::uuid, true); COMMIT;`,
    ]);
    assert(fail.code !== 0, "expected transaction abort on audit failure");
    assert(/AUDIT_REQUIRED/.test(fail.out), fail.out);

    assertEquals(
      await psql(`SELECT scheduled_hold_reason FROM trips WHERE id='${trip}';`),
      "publication_pending",
      "trip must remain unchanged after audit failure",
    );
    assertEquals(
      await psql(`SELECT scheduled_status FROM trips WHERE id='${trip}';`),
      "admin_held",
    );
    assertEquals(
      await psql(`SELECT count(*)::text FROM audit_logs WHERE trip_id='${trip}';`),
      "0",
    );

    // Make Available + Assign also roll back on audit failure.
    const failPub = await sh([
      "psql",
      DATABASE_URL,
      "-v",
      "ON_ERROR_STOP=1",
      "-Atc",
      `BEGIN; SELECT emergency_make_available_atomic('${trip}'::uuid, '${actor}'::uuid, true); COMMIT;`,
    ]);
    assert(failPub.code !== 0);
    assertEquals(
      await psql(`SELECT scheduled_broadcast_at::text FROM trips WHERE id='${trip}';`),
      "",
    );

    const failAssign = await sh([
      "psql",
      DATABASE_URL,
      "-v",
      "ON_ERROR_STOP=1",
      "-Atc",
      `BEGIN; SELECT emergency_assign_atomic('${trip}'::uuid, '22222222-2222-2222-2222-222222222222'::uuid, '${actor}'::uuid, true); COMMIT;`,
    ]);
    assert(failAssign.code !== 0);
    assertEquals(
      await psql(`SELECT confirmed_driver_id::text FROM trips WHERE id='${trip}';`),
      "",
    );

    // Success assign after failures still works.
    assertEquals(
      await psql(
        `SELECT emergency_assign_atomic('${trip}'::uuid, '22222222-2222-2222-2222-222222222222'::uuid, '${actor}'::uuid, false);`,
      ),
      "OK",
    );
    assertEquals(
      await psql(`SELECT confirmed_driver_id::text FROM trips WHERE id='${trip}';`),
      "22222222-2222-2222-2222-222222222222",
    );
    assertEquals(
      await psql(
        `SELECT count(*)::text FROM audit_logs WHERE event_type='ADMIN_SCHEDULED_ASSIGN_NOW';`,
      ),
      "1",
    );

    // Lock: production migration must use single-function mutate+audit (no compensate pattern).
    const mig = await Deno.readTextFile(
      new URL(
        "../../migrations/20270213140000_scheduled_marketplace_emergency_mutate_atomic.sql",
        import.meta.url,
      ),
    );
    assert(mig.includes("admin_scheduled_emergency_mutate"));
    assert(mig.includes("INSERT INTO public.audit_logs"));
    assert(mig.includes("Audit failure rolls back"));

    const edge = await Deno.readTextFile(
      new URL("../admin-scheduled-ride-action/index.ts", import.meta.url),
    );
    assert(edge.includes("admin_scheduled_emergency_mutate"));
    assert(!edge.includes("auditOrFail"));
    assert(!edge.includes("compensate"));

    await sh(["docker", "rm", "-f", "p3-audit-pg"]);
  },
});
