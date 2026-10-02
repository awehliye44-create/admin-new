/**
 * In-memory PostgREST-shaped fake for waiting-clock tests.
 * Supports the query shapes waitingSegmentClock and terminal disposition use.
 */
export type FakeRow = Record<string, unknown>;

/** MK-261002-004 pickup segments (reconstructed from production evidence). */
export const INCIDENT_SEGMENTS = [
  { started_at: "2026-10-02T10:07:36.310Z", ended_at: "2026-10-02T10:10:53.008Z" }, // 196.698 s
  { started_at: "2026-10-02T10:11:07.962Z", ended_at: "2026-10-02T10:11:52.924Z" }, // 44.962 s
  { started_at: "2026-10-02T10:12:08.120Z", ended_at: null as string | null }, // open, 2.845 s at cancel
];
export const INCIDENT_CANCELLED_AT = "2026-10-02T10:12:10.965Z";

export type FakeDbOptions = {
  failSelect?: (table: string, cols: string) => boolean;
  failUpdate?: (table: string) => boolean;
};

export type FakeWrite = {
  op: "update" | "insert";
  table: string;
  payload: FakeRow;
  filters: Array<[string, string, unknown]>;
};

export function createFakeDb(
  seed: Record<string, FakeRow[]>,
  opts: FakeDbOptions = {},
) {
  const tables: Record<string, FakeRow[]> = {};
  for (const [name, rows] of Object.entries(seed)) {
    tables[name] = rows.map((r) => ({ ...r }));
  }
  const writes: FakeWrite[] = [];
  let seq = 0;

  function from(table: string) {
    const state = {
      op: "select" as "select" | "update" | "insert",
      cols: "*",
      payload: null as FakeRow | null,
      filters: [] as Array<[string, string, unknown]>,
      order: null as [string, boolean] | null,
      limit: null as number | null,
      returning: false,
    };
    const match = (r: FakeRow) =>
      state.filters.every(([k, op, v]) => {
        if (op === "eq") return r[k] === v;
        if (op === "is") return (r[k] ?? null) === v;
        if (op === "in") return (v as unknown[]).includes(r[k]);
        return true;
      });
    const exec = (): { data: unknown; error: { message: string } | null } => {
      const rows = (tables[table] ??= []);
      if (state.op === "select") {
        if (opts.failSelect?.(table, state.cols)) {
          return { data: null, error: { message: "simulated select failure" } };
        }
        let out = rows.filter(match);
        if (state.order) {
          const [k, asc] = state.order;
          out = [...out].sort((a, b) => {
            const av = String(a[k] ?? "");
            const bv = String(b[k] ?? "");
            return asc ? av.localeCompare(bv) : bv.localeCompare(av);
          });
        }
        if (state.limit != null) out = out.slice(0, state.limit);
        return { data: out.map((r) => ({ ...r })), error: null };
      }
      if (state.op === "update") {
        if (opts.failUpdate?.(table)) {
          return { data: null, error: { message: "simulated update failure" } };
        }
        const hit = rows.filter(match);
        for (const r of hit) Object.assign(r, state.payload);
        writes.push({
          op: "update",
          table,
          payload: { ...(state.payload ?? {}) },
          filters: [...state.filters],
        });
        return { data: state.returning ? hit.map((r) => ({ ...r })) : null, error: null };
      }
      const row = { id: `${table}-${++seq}`, ...(state.payload ?? {}) };
      rows.push(row);
      writes.push({ op: "insert", table, payload: { ...row }, filters: [] });
      return { data: state.returning ? [{ ...row }] : null, error: null };
    };
    // deno-lint-ignore no-explicit-any
    const b: any = {
      select(cols = "*") {
        if (state.op === "select") state.cols = cols;
        else state.returning = true;
        return b;
      },
      insert(p: FakeRow) {
        state.op = "insert";
        state.payload = p;
        return b;
      },
      update(p: FakeRow) {
        state.op = "update";
        state.payload = p;
        return b;
      },
      eq(k: string, v: unknown) {
        state.filters.push([k, "eq", v]);
        return b;
      },
      is(k: string, v: unknown) {
        state.filters.push([k, "is", v]);
        return b;
      },
      in(k: string, v: unknown[]) {
        state.filters.push([k, "in", v]);
        return b;
      },
      order(k: string, o?: { ascending?: boolean }) {
        state.order = [k, o?.ascending !== false];
        return b;
      },
      limit(n: number) {
        state.limit = n;
        return b;
      },
      maybeSingle() {
        const r = exec();
        const data = Array.isArray(r.data) ? (r.data[0] ?? null) : r.data;
        return Promise.resolve({ data, error: r.error });
      },
      single() {
        return b.maybeSingle();
      },
      then(
        resolve: (v: unknown) => unknown,
        reject?: (e: unknown) => unknown,
      ) {
        try {
          return Promise.resolve(exec()).then(resolve, reject);
        } catch (err) {
          return Promise.reject(err).then(resolve, reject);
        }
      },
    };
    return b;
  }

  return { client: { from }, tables, writes };
}
