/**
 * Minimal in-memory Supabase double for booking finalize tests.
 * Supports from(t).select().eq()/is()/limit()/maybeSingle(), update().eq().is().select(), rpc().
 */

type Row = Record<string, unknown>;

export type FakeCall =
  | { kind: "select"; table: string; filters: Array<[string, string, unknown]> }
  | { kind: "update"; table: string; patch: Row; filters: Array<[string, string, unknown]> }
  | { kind: "rpc"; fn: string; args: Row };

export function createFakeSupabase(init: {
  tables?: Record<string, Row[]>;
  rpc?: (fn: string, args: Row) => { data: unknown; error: { message: string } | null } | Promise<never>;
  updateError?: Record<string, { message: string }>;
}) {
  const tables: Record<string, Row[]> = structuredClone(init.tables ?? {});
  const calls: FakeCall[] = [];

  const matches = (row: Row, filters: Array<[string, string, unknown]>) =>
    filters.every(([op, col, val]) => (op === "is" ? (row[col] ?? null) === val : row[col] === val));

  function builder(table: string) {
    const filters: Array<[string, string, unknown]> = [];
    let mode: "select" | "update" = "select";
    let patch: Row = {};
    let limitN: number | null = null;
    let returnRows = false;

    const run = () => {
      const rows = (tables[table] ?? []).filter((r) => matches(r, filters));
      if (mode === "update") {
        calls.push({ kind: "update", table, patch, filters: [...filters] });
        const err = init.updateError?.[table];
        if (err) return { data: null, error: err };
        rows.forEach((r) => Object.assign(r, patch));
        return { data: returnRows ? rows.map((r) => ({ ...r })) : null, error: null };
      }
      calls.push({ kind: "select", table, filters: [...filters] });
      const out = limitN == null ? rows : rows.slice(0, limitN);
      return { data: out.map((r) => ({ ...r })), error: null };
    };

    const api: Record<string, unknown> = {
      select(_cols?: string) {
        if (mode === "update") returnRows = true;
        return api;
      },
      update(p: Row) {
        mode = "update";
        patch = p;
        return api;
      },
      eq(col: string, val: unknown) {
        filters.push(["eq", col, val]);
        return api;
      },
      is(col: string, val: unknown) {
        filters.push(["is", col, val]);
        return api;
      },
      in(_col: string, _vals: unknown[]) {
        return api;
      },
      limit(n: number) {
        limitN = n;
        return api;
      },
      maybeSingle() {
        const res = run();
        const data = Array.isArray(res.data) ? (res.data[0] ?? null) : res.data;
        return Promise.resolve({ data, error: res.error });
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        try {
          return Promise.resolve(run()).then(resolve, reject);
        } catch (e) {
          return reject ? reject(e) : Promise.reject(e);
        }
      },
    };
    return api;
  }

  const client = {
    from: (table: string) => builder(table),
    rpc: async (fn: string, args: Row) => {
      calls.push({ kind: "rpc", fn, args });
      if (!init.rpc) return { data: null, error: { message: "no rpc" } };
      return await init.rpc(fn, args);
    },
  };

  return { client: client as unknown as import("npm:@supabase/supabase-js@2.57.2").SupabaseClient, calls, tables };
}
