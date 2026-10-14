/**
 * Recovery-job alerts: a real failure is visible, a success is silent,
 * and a repeat failure refreshes the same open alert.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  raiseRecoveryJobAlert,
  RECOVERY_JOB_ALERT,
  runWaitingShortfallRecovery,
  type RecoveryRunBody,
} from "./recoveryJob.ts";

type AlertRow = {
  id: string;
  fingerprint: string;
  status: string;
  severity: string;
  title: string;
  description: string;
  fingerprint_count: number;
  metadata: { money_moved?: boolean; provider_called?: boolean };
};

type TableResult = { data: unknown; error: { message: string; code?: string } | null };

function alertStore() {
  const rows: AlertRow[] = [];
  let seq = 0;
  const alerts: string[] = [];

  function query(table: string) {
    const filters: Record<string, unknown> = {};
    let pendingUpdate: Record<string, unknown> | null = null;
    const api = {
      select() { return api; },
      not() { return api; },
      order() { return api; },
      limit() { return api; },
      eq(column: string, value: unknown) {
        filters[column] = value;
        return api;
      },
      in(column: string, values: unknown[]) {
        filters[column] = values;
        return api;
      },
      like() { return api; },
      insert(row: Record<string, unknown>): Promise<TableResult> {
        if (table !== "ops_alerts") return Promise.resolve({ data: null, error: null });
        const open = rows.find((r) =>
          r.fingerprint === row.fingerprint && (r.status === "open" || r.status === "acknowledged")
        );
        if (open) {
          return Promise.resolve({ data: null, error: { message: "duplicate", code: "23505" } });
        }
        seq += 1;
        rows.push({
          id: `alert-${seq}`,
          fingerprint: String(row.fingerprint),
          status: String(row.status),
          severity: String(row.severity),
          title: String(row.title),
          description: String(row.description),
          fingerprint_count: 1,
          metadata: row.metadata as AlertRow["metadata"],
        });
        alerts.push(String(row.description));
        return Promise.resolve({ data: null, error: null });
      },
      update(patch: Record<string, unknown>) {
        pendingUpdate = patch;
        return api;
      },
      maybeSingle(): Promise<TableResult> {
        const match = rows.find((r) => matches(r, filters));
        return Promise.resolve({ data: match ?? null, error: null });
      },
      then(resolve: (value: TableResult) => unknown) {
        if (pendingUpdate && table === "ops_alerts") {
          const match = rows.find((r) => matches(r, filters));
          if (match) Object.assign(match, pendingUpdate);
        }
        if (table === "payment_sessions") {
          return Promise.resolve(resolve({ data: sessions, error: sessionError }));
        }
        if (table === "customer_receivables") {
          return Promise.resolve(resolve({ data: receivables, error: receivableError }));
        }
        if (table === "ops_alerts" && !pendingUpdate) {
          return Promise.resolve(resolve({ data: [], error: alertReadError }));
        }
        return Promise.resolve(resolve({ data: null, error: null }));
      },
    };
    return api;
  }

  let sessions: unknown[] = [];
  let sessionError: { message: string; code?: string } | null = null;
  let receivables: unknown[] = [];
  let receivableError: { message: string; code?: string } | null = null;
  let alertReadError: { message: string; code?: string } | null = null;
  let tripPassenger: string | null = "customer-1";
  let throwTripLookup = false;

  const client = {
    from(table: string) {
      if (table === "trips") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: () => {
                if (throwTripLookup) return Promise.reject(new Error("statement timeout"));
                return Promise.resolve({
                  data: tripPassenger ? { passenger_id: tripPassenger } : null,
                  error: null,
                });
              },
            }),
          }),
        };
      }
      return query(table);
    },
    async rpc(name: string) {
      if (name === "customer_receivable_record_declined_increment") {
        return { data: { ok: true, receivable_id: "recv-1", created: true }, error: null };
      }
      if (name === "finance_resolve_shortfall_exception_receivable") {
        return { data: { ok: true }, error: null };
      }
      return { data: null, error: { message: `unexpected ${name}` } };
    },
  };

  return {
    client,
    rows,
    alerts,
    setSessions(next: unknown[]) { sessions = next; },
    failSessions(message: string) { sessionError = { message }; },
    failReceivables(message: string) { receivableError = { message }; },
    throwOnTripLookup() { throwTripLookup = true; },
  };
}

function matches(row: AlertRow, filters: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(filters)) {
    if (Array.isArray(value)) {
      if (!value.includes((row as unknown as Record<string, unknown>)[key])) return false;
    } else if ((row as unknown as Record<string, unknown>)[key] !== value) return false;
  }
  return true;
}

const marker = {
  id: "session-1",
  trip_id: "trip-1",
  provider_order_id: "order-1",
  status: "captured",
  provider_state: "COMPLETED",
  created_at: "2026-09-23T12:00:00.000Z",
  captured_amount_pence: 500,
  metadata: {
    shortfall_pence: 40,
    shortfall_expected_fare_pence: 540,
    shortfall_captured_pence: 500,
  },
};

Deno.test("a session read failure raises one critical alert and moves no money", async () => {
  const db = alertStore();
  db.failSessions("connection reset by peer");
  const result = await runWaitingShortfallRecovery(db.client as never);
  assertEquals(result.httpStatus, 500);
  assertEquals(result.body.money_moved, false);
  assertEquals(result.body.provider_called, false);
  assertEquals(result.body.alert, "inserted");
  assertEquals(db.rows.length, 1);
  assertEquals(db.rows[0].fingerprint, RECOVERY_JOB_ALERT);
  assertEquals(db.rows[0].severity, "critical");
  assertEquals(db.rows[0].status, "open");
  assertEquals(db.rows[0].description.includes("connection reset by peer"), true);
  assertEquals(db.rows[0].metadata.money_moved, false);
});

Deno.test("a thrown candidate raises one alert and does not claim success without saying so", async () => {
  const db = alertStore();
  db.setSessions([marker]);
  db.throwOnTripLookup();
  const result = await runWaitingShortfallRecovery(db.client as never);
  assertEquals(result.httpStatus, 200);
  assertEquals(result.body.errors, 1);
  assertEquals(result.body.money_moved, false);
  assertEquals(result.body.provider_called, false);
  assertEquals(db.rows.length, 1);
  assertEquals(db.rows[0].description.includes("1 failed"), true);
});

Deno.test("a successful run with nothing to recover does not alert", async () => {
  const db = alertStore();
  const result = await runWaitingShortfallRecovery(db.client as never);
  assertEquals(result.httpStatus, 200);
  assertEquals(result.body.ok, true);
  assertEquals(result.body.examined, 0);
  assertEquals(result.body.alert, "none");
  assertEquals(db.rows.length, 0);
  assertEquals((result.body as RecoveryRunBody).money_moved, false);
});

Deno.test("a successful receivable save does not raise the job alert", async () => {
  const db = alertStore();
  db.setSessions([marker]);
  const result = await runWaitingShortfallRecovery(db.client as never);
  assertEquals(result.body.receivable_recorded, 1);
  assertEquals(result.body.errors, 0);
  assertEquals(result.body.alert, "none");
  assertEquals(db.rows.length, 0);
});

Deno.test("repeated failures refresh the same open alert", async () => {
  const db = alertStore();
  const first = await raiseRecoveryJobAlert(db.client as never, "first outage");
  const second = await raiseRecoveryJobAlert(db.client as never, "second outage");
  const third = await raiseRecoveryJobAlert(db.client as never, "third outage");
  assertEquals(first, "inserted");
  assertEquals(second, "refreshed");
  assertEquals(third, "refreshed");
  assertEquals(db.rows.length, 1);
  assertEquals(db.rows[0].fingerprint_count, 3);
  assertEquals(db.rows[0].description, "third outage");
  assertEquals(db.rows[0].status, "open");
});
