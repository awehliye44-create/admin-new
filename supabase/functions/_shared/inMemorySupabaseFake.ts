/**
 * Minimal in-memory Supabase query-builder fake for Deno execution tests.
 *
 * Each query executes synchronously inside a single microtask when awaited, so
 * filtered UPDATEs behave like a Postgres compare-and-set (row-level atomic):
 * two racing `update().eq().is()` calls cannot both match the same row state.
 *
 * Supports: select / insert / update / delete, eq / neq / is / in / not(in) /
 * gte / lte, order, limit, maybeSingle, single, select() after write.
 * NOT a general Supabase mock — only what the waiting / rematch tests need.
 */
// deno-lint-ignore-file no-explicit-any

export type FakeRow = Record<string, any>;
export type FakeDb = Record<string, FakeRow[]>;

type Filter = (row: FakeRow) => boolean;

export interface FakeSupabase {
  db: FakeDb;
  from(table: string): any;
  rpc(name: string, args?: Record<string, any>): Promise<{ data: any; error: any }>;
  /** Every write issued, in order — for ordering/CAS assertions. */
  writes: Array<{ table: string; op: string; payload: unknown; matched: number }>;
}

export function createInMemorySupabase(seed: FakeDb = {}): FakeSupabase {
  const db: FakeDb = {};
  for (const [t, rows] of Object.entries(seed)) {
    db[t] = rows.map((r) => ({ ...r }));
  }
  let seq = 0;
  const writes: FakeSupabase["writes"] = [];

  function from(table: string) {
    db[table] ??= [];
    const filters: Filter[] = [];
    let op: "select" | "insert" | "update" | "delete" = "select";
    let payload: any = null;
    let orderBy: { col: string; asc: boolean } | null = null;
    let limitN: number | null = null;
    let wantRows = true; // select() after write returns rows
    let single: "maybe" | "single" | null = null;

    const exec = (): { data: any; error: any } => {
      const matching = db[table].filter((r) => filters.every((f) => f(r)));
      if (op === "insert") {
        const arr = Array.isArray(payload) ? payload : [payload];
        const inserted = arr.map((p: FakeRow) => {
          const row = { id: p.id ?? `${table}-${++seq}`, ...p };
          db[table].push(row);
          return row;
        });
        writes.push({ table, op, payload, matched: inserted.length });
        return shape(inserted);
      }
      if (op === "update") {
        for (const r of matching) Object.assign(r, payload);
        writes.push({ table, op, payload, matched: matching.length });
        return shape(matching.map((r) => ({ ...r })));
      }
      if (op === "delete") {
        db[table] = db[table].filter((r) => !matching.includes(r));
        writes.push({ table, op, payload: null, matched: matching.length });
        return shape(matching);
      }
      let rows = matching.map((r) => ({ ...r }));
      if (orderBy) {
        const { col, asc } = orderBy;
        rows.sort((a, b) => {
          const x = a[col];
          const y = b[col];
          if (x === y) return 0;
          return (x < y ? -1 : 1) * (asc ? 1 : -1);
        });
      }
      if (limitN != null) rows = rows.slice(0, limitN);
      return shape(rows);
    };

    const shape = (rows: FakeRow[]) => {
      if (!wantRows) return { data: null, error: null };
      if (single) return { data: rows[0] ?? null, error: null };
      return { data: rows, error: null };
    };

    const builder: any = {
      select(_cols?: string) {
        wantRows = true;
        return builder;
      },
      insert(p: any) {
        op = "insert";
        payload = p;
        wantRows = false;
        return builder;
      },
      update(p: any) {
        op = "update";
        payload = p;
        wantRows = false;
        return builder;
      },
      delete() {
        op = "delete";
        wantRows = false;
        return builder;
      },
      eq(col: string, v: any) {
        filters.push((r) => r[col] === v);
        return builder;
      },
      neq(col: string, v: any) {
        filters.push((r) => r[col] !== v);
        return builder;
      },
      is(col: string, v: any) {
        filters.push((r) => (v === null ? r[col] == null : r[col] === v));
        return builder;
      },
      in(col: string, vals: any[]) {
        filters.push((r) => vals.includes(r[col]));
        return builder;
      },
      not(col: string, operator: string, v: any) {
        if (operator === "in") {
          const list = typeof v === "string"
            ? v.replace(/^\(|\)$/g, "").split(",").map((x) => x.trim())
            : (v as any[]);
          filters.push((r) => !list.includes(r[col]));
        } else if (operator === "is") {
          filters.push((r) => (v === null ? r[col] != null : r[col] !== v));
        }
        return builder;
      },
      gte(col: string, v: any) {
        filters.push((r) => r[col] >= v);
        return builder;
      },
      lte(col: string, v: any) {
        filters.push((r) => r[col] <= v);
        return builder;
      },
      order(col: string, opts?: { ascending?: boolean }) {
        orderBy = { col, asc: opts?.ascending !== false };
        return builder;
      },
      limit(n: number) {
        limitN = n;
        return builder;
      },
      maybeSingle() {
        single = "maybe";
        wantRows = true;
        return builder;
      },
      single() {
        single = "single";
        wantRows = true;
        return builder;
      },
      then(resolve: (v: any) => any, reject?: (e: any) => any) {
        try {
          return Promise.resolve(exec()).then(resolve, reject);
        } catch (e) {
          return Promise.reject(e).then(resolve, reject);
        }
      },
    };
    return builder;
  }

  /**
   * RPC emulation. `open_waiting_segment_or_reuse` mirrors the SQL function: the
   * check + insert run in ONE synchronous step (like the unique partial index
   * uq_trip_waiting_segments_one_open_per_session), so concurrent callers reuse.
   */
  function rpc(name: string, args: Record<string, any> = {}) {
    const run = (): { data: any; error: any } => {
      if (name === "open_waiting_segment_or_reuse") {
        db["trip_waiting_segments"] ??= [];
        const stop = args.p_location_type === "stop" ? (args.p_stop_id ?? null) : null;
        const existing = db["trip_waiting_segments"]
          .filter((r) =>
            r.trip_id === args.p_trip_id &&
            r.location_type === args.p_location_type &&
            r.ended_at == null &&
            (args.p_location_type !== "stop" || (r.stop_id ?? null) === stop)
          )
          .sort((a, b) => (a.started_at < b.started_at ? -1 : a.started_at > b.started_at ? 1 : 0))[0];
        if (existing) {
          return { data: [{ segment_id: existing.id, opened: false }], error: null };
        }
        const row = {
          id: `trip_waiting_segments-${++seq}`,
          trip_id: args.p_trip_id,
          location_type: args.p_location_type,
          stop_id: stop,
          stop_index: args.p_stop_index ?? null,
          started_at: args.p_started_at,
          ended_at: null,
          inside_radius: true,
          distance_meters: args.p_distance_meters ?? null,
          source_location: args.p_source_location ?? null,
        };
        db["trip_waiting_segments"].push(row);
        writes.push({ table: "trip_waiting_segments", op: "insert", payload: row, matched: 1 });
        return { data: [{ segment_id: row.id, opened: true }], error: null };
      }
      return {
        data: null,
        error: { code: "PGRST202", message: `Could not find the function ${name}` },
      };
    };
    return Promise.resolve().then(run);
  }

  return { db, from, rpc, writes };
}
