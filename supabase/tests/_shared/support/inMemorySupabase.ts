/**
 * Minimal in-memory PostgREST-style client for behavioural tests.
 * Supports the builder subset used by the payment-evidence / dispatch modules.
 * Unknown builder methods throw so a test never silently passes on unsupported SQL.
 */

type Row = Record<string, unknown>;
type Filter = (row: Row) => boolean;

export type WriteOp = {
  table: string;
  op: "insert" | "update" | "upsert" | "delete";
  values: Row | Row[];
  matched: number;
};

export type InMemoryOptions = {
  tables?: Record<string, Row[]>;
  uniques?: Record<string, string[]>;
  rpc?: Record<string, (args: Record<string, unknown>) => { data: unknown; error: unknown }>;
  /** Postgres enum columns: writes outside the set fail with 22P02 and change nothing. */
  enums?: Record<string, Record<string, readonly string[]>>;
};

export type RejectedWrite = { table: string; column: string; value: unknown; code: "22P02" };

function parseInList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  const s = String(raw ?? "").trim().replace(/^\(/, "").replace(/\)$/, "");
  if (!s) return [];
  return s.split(",").map((p) => p.trim().replace(/^"/, "").replace(/"$/, ""));
}

function cmp(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function project(row: Row, columns: string | undefined): Row {
  if (!columns || columns.trim() === "*" || columns.includes("(")) return { ...row };
  const out: Row = {};
  for (const raw of columns.split(",")) {
    const col = raw.trim();
    if (!col) continue;
    out[col] = row[col] ?? null;
  }
  return out;
}

export class InMemorySupabase {
  tables: Record<string, Row[]>;
  uniques: Record<string, string[]>;
  rpcHandlers: InMemoryOptions["rpc"];
  enums: NonNullable<InMemoryOptions["enums"]>;
  writes: WriteOp[] = [];
  rejectedWrites: RejectedWrite[] = [];
  rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  private seq = 0;

  constructor(opts: InMemoryOptions = {}) {
    this.tables = {};
    for (const [t, rows] of Object.entries(opts.tables ?? {})) {
      this.tables[t] = rows.map((r) => structuredClone(r));
    }
    this.uniques = opts.uniques ?? {};
    this.rpcHandlers = opts.rpc ?? {};
    this.enums = opts.enums ?? {};
  }

  enumViolation(table: string, values: Row): RejectedWrite | null {
    for (const [column, allowed] of Object.entries(this.enums[table] ?? {})) {
      if (!(column in values) || values[column] == null) continue;
      if (!allowed.includes(String(values[column]))) {
        return { table, column, value: values[column], code: "22P02" };
      }
    }
    return null;
  }

  rows(table: string): Row[] {
    return (this.tables[table] ??= []);
  }

  writesTo(table: string, op?: WriteOp["op"]): WriteOp[] {
    return this.writes.filter((w) => w.table === table && (!op || w.op === op));
  }

  from(table: string) {
    return new QueryBuilder(this, table);
  }

  rpc(name: string, args: Record<string, unknown> = {}) {
    this.rpcCalls.push({ name, args });
    const handler = this.rpcHandlers?.[name];
    const result = handler
      ? handler(args)
      : { data: null, error: { message: `rpc_not_stubbed:${name}`, code: "PGRST202" } };
    return Promise.resolve(result);
  }

  nextId(): string {
    this.seq += 1;
    return `00000000-0000-4000-8000-${String(this.seq).padStart(12, "0")}`;
  }
}

class QueryBuilder implements PromiseLike<{ data: unknown; error: unknown; count?: number | null }> {
  private filters: Filter[] = [];
  private op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  private payload: Row | Row[] | null = null;
  private selectCols: string | undefined;
  private returning = false;
  private orderBy: Array<{ col: string; asc: boolean }> = [];
  private limitN: number | null = null;
  private singleMode: "maybe" | "strict" | null = null;
  private countHead = false;

  constructor(private db: InMemorySupabase, private table: string) {}

  select(cols?: string, opts?: { count?: string; head?: boolean }) {
    if (this.op === "select") {
      this.selectCols = cols;
      if (opts?.head) this.countHead = true;
    } else {
      this.returning = true;
      this.selectCols = cols;
    }
    return this;
  }
  insert(values: Row | Row[]) {
    this.op = "insert";
    this.payload = values;
    return this;
  }
  upsert(values: Row | Row[]) {
    this.op = "upsert";
    this.payload = values;
    return this;
  }
  update(values: Row) {
    this.op = "update";
    this.payload = values;
    return this;
  }
  delete() {
    this.op = "delete";
    return this;
  }
  eq(col: string, val: unknown) {
    this.filters.push((r) => r[col] === val);
    return this;
  }
  neq(col: string, val: unknown) {
    this.filters.push((r) => r[col] !== val);
    return this;
  }
  in(col: string, vals: unknown[]) {
    const set = new Set(parseInList(vals));
    this.filters.push((r) => set.has(r[col]));
    return this;
  }
  is(col: string, val: unknown) {
    this.filters.push((r) => (val === null ? r[col] == null : r[col] === val));
    return this;
  }
  gt(col: string, val: unknown) {
    this.filters.push((r) => r[col] != null && cmp(r[col], val) > 0);
    return this;
  }
  gte(col: string, val: unknown) {
    this.filters.push((r) => r[col] != null && cmp(r[col], val) >= 0);
    return this;
  }
  lt(col: string, val: unknown) {
    this.filters.push((r) => r[col] != null && cmp(r[col], val) < 0);
    return this;
  }
  lte(col: string, val: unknown) {
    this.filters.push((r) => r[col] != null && cmp(r[col], val) <= 0);
    return this;
  }
  not(col: string, op: string, val: unknown) {
    if (op === "in") {
      const set = new Set(parseInList(val));
      this.filters.push((r) => r[col] != null && !set.has(r[col]));
    } else if (op === "is") {
      this.filters.push((r) => (val === null || val === "null" ? r[col] != null : r[col] !== val));
    } else if (op === "eq") {
      this.filters.push((r) => r[col] !== val);
    } else {
      throw new Error(`InMemorySupabase: unsupported not() operator ${op}`);
    }
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.orderBy.push({ col, asc: opts?.ascending !== false });
    return this;
  }
  limit(n: number) {
    this.limitN = n;
    return this;
  }
  maybeSingle() {
    this.singleMode = "maybe";
    return this;
  }
  single() {
    this.singleMode = "strict";
    return this;
  }

  private matching(): Row[] {
    return this.db.rows(this.table).filter((r) => this.filters.every((f) => f(r)));
  }

  private finish(rows: Row[]) {
    let out = [...rows];
    for (const o of [...this.orderBy].reverse()) {
      out.sort((a, b) => (o.asc ? cmp(a[o.col], b[o.col]) : cmp(b[o.col], a[o.col])));
    }
    if (this.limitN != null) out = out.slice(0, this.limitN);
    const projected = out.map((r) => project(r, this.selectCols));
    if (this.singleMode) {
      if (projected.length > 1 && this.singleMode === "strict") {
        return { data: null, error: { message: "multiple rows", code: "PGRST116" } };
      }
      if (projected.length === 0 && this.singleMode === "strict") {
        return { data: null, error: { message: "no rows", code: "PGRST116" } };
      }
      return { data: projected[0] ?? null, error: null };
    }
    return { data: projected, error: null };
  }

  private execute(): { data: unknown; error: unknown; count?: number | null } {
    const table = this.db.rows(this.table);
    if (this.op !== "select" && this.op !== "delete") {
      const list = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
      for (const values of list) {
        const violation = this.db.enumViolation(this.table, values ?? {});
        if (violation) {
          this.db.rejectedWrites.push(violation);
          return {
            data: null,
            error: {
              code: violation.code,
              message: `invalid input value for enum ${violation.column}: "${String(violation.value)}"`,
            },
          };
        }
      }
    }
    if (this.op === "select") {
      const rows = this.matching();
      if (this.countHead) return { data: null, error: null, count: rows.length };
      return this.finish(rows);
    }
    if (this.op === "insert" || this.op === "upsert") {
      const list = (Array.isArray(this.payload) ? this.payload : [this.payload]) as Row[];
      const inserted: Row[] = [];
      for (const raw of list) {
        const row: Row = { id: this.db.nextId(), created_at: new Date().toISOString(), ...structuredClone(raw) };
        for (const col of this.db.uniques[this.table] ?? []) {
          const clash = table.find((r) => r[col] != null && r[col] === row[col]);
          if (clash) {
            if (this.op === "upsert") {
              Object.assign(clash, row, { id: clash.id });
              inserted.push(clash);
              continue;
            }
            this.db.writes.push({ table: this.table, op: "insert", values: raw, matched: 0 });
            return {
              data: null,
              error: { code: "23505", message: `duplicate key value violates unique constraint on ${col}` },
            };
          }
        }
        table.push(row);
        inserted.push(row);
      }
      this.db.writes.push({ table: this.table, op: this.op, values: list, matched: inserted.length });
      return this.returning ? this.finish(inserted) : { data: null, error: null };
    }
    if (this.op === "update") {
      const rows = this.matching();
      for (const r of rows) Object.assign(r, structuredClone(this.payload as Row));
      this.db.writes.push({ table: this.table, op: "update", values: this.payload as Row, matched: rows.length });
      return this.returning ? this.finish(rows) : { data: null, error: null };
    }
    const rows = this.matching();
    this.db.tables[this.table] = table.filter((r) => !rows.includes(r));
    this.db.writes.push({ table: this.table, op: "delete", values: [], matched: rows.length });
    return { data: null, error: null };
  }

  then<T1 = { data: unknown; error: unknown }, T2 = never>(
    onfulfilled?: ((value: { data: unknown; error: unknown; count?: number | null }) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve().then(() => this.execute()).then(onfulfilled, onrejected);
  }
}

export function asSupabase(db: InMemorySupabase): never {
  // deno-lint-ignore no-explicit-any
  return new Proxy(db as any, {
    get(target, prop) {
      if (prop in target) return target[prop];
      throw new Error(`InMemorySupabase: unsupported client member ${String(prop)}`);
    },
  }) as never;
}

export type FetchCall = { url: string; method: string; body: unknown };

/** Stubs globalThis.fetch; returns a restore function plus the recorded calls. */
export function stubFetch(
  handler: (call: FetchCall) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>,
): { calls: FetchCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    let body: unknown = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    const call = { url, method, body };
    calls.push(call);
    const res = await handler(call);
    return new Response(JSON.stringify(res.body ?? {}), {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}
