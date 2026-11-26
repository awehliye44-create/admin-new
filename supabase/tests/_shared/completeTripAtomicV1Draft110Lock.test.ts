/**
 * #110 P2 — complete_trip_atomic_v1 DRAFT lock.
 *
 * STOP BEFORE PROD: the atomic completion RPC is a LOCAL-ONLY draft. This test pins:
 *   1. the draft SQL exists under migrations/_draft_review_only/ (never a live migration),
 *   2. it documents STOP-before-prod and keeps provider calls out of the transaction,
 *   3. it reuses the existing PENDING RPC (exactly one PENDING, no TEN/RELEASE/Available),
 *   4. the 20-minute tip window matches tipWindowConstants,
 *   5. stop-workflow (and every other edge function) does NOT call the atomic RPC yet,
 *   6. the local fixture script refuses non-local hosts.
 *
 * Cutover to prod requires a deliberate change to this test (owner sign-off) — do not
 * soften it to "make it green".
 *
 * Run: deno test --allow-read supabase/tests/_shared/completeTripAtomicV1Draft110Lock.test.ts
 */
import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { TIP_WINDOW_MS } from "../../functions/_shared/tipWindowConstants.ts";

const root = new URL("../../", import.meta.url);
const read = (rel: string) => Deno.readTextFileSync(new URL(rel, root));

const DRAFT_REL = "migrations/_draft_review_only/DRAFT_complete_trip_atomic_v1.sql";
const FIXTURE_REL = "tests/complete_trip_atomic_v1_110_local.sh";
const RPC = "complete_trip_atomic_v1";

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

Deno.test("draft SQL exists only under _draft_review_only and not as a live migration", () => {
  const draft = read(DRAFT_REL);
  assertStringIncludes(draft, "public.complete_trip_atomic_v1(");
  assertStringIncludes(draft, "DRAFT");

  for (const entry of Deno.readDirSync(new URL("migrations/", root))) {
    if (!entry.isFile || !entry.name.endsWith(".sql")) continue;
    const body = Deno.readTextFileSync(new URL(`migrations/${entry.name}`, root));
    assert(
      !body.includes(RPC),
      `${entry.name}: ${RPC} must not be in a live migration (STOP BEFORE PROD)`,
    );
  }
});

Deno.test("draft documents STOP before prod and no provider calls", () => {
  const draft = read(DRAFT_REL);
  assertStringIncludes(draft, "STOP BEFORE PROD");
  assertStringIncludes(draft, "DO NOT APPLY TO PRODUCTION");
  assertStringIncludes(draft, "No provider (Revolut) call");

  const code = stripSqlComments(draft).toLowerCase();
  for (const forbidden of ["net.http", "http_post", "pg_net", "revolut", "supabase_functions"]) {
    assert(!code.includes(forbidden), `draft code must not reference ${forbidden}`);
  }
});

Deno.test("draft reuses the existing PENDING RPC and never writes Available/TEN/RELEASE", () => {
  const code = stripSqlComments(read(DRAFT_REL));
  assertStringIncludes(code, "public.credit_trip_earning_pending(");
  // Exactly one PENDING path, PLATFORM_COLLECTED only.
  assertEquals(code.match(/credit_trip_earning_pending\(/g)?.length, 1);
  assertStringIncludes(code, "v_financial_model = 'PLATFORM_COLLECTED'");
  assert(
    !/INSERT\s+INTO\s+public\.driver_wallet_ledger/i.test(code),
    "draft must not insert ledger rows directly — only via credit_trip_earning_pending",
  );
  for (const forbidden of ["TRIP_EARNING_NET", "TRIP_EARNING_PENDING_RELEASE", "payment_ssot_cutover"]) {
    assert(!code.includes(forbidden), `draft must not touch ${forbidden}`);
  }
  // Soft pending failure aborts the whole transaction.
  assertStringIncludes(code, "COMPLETE_TRIP_ATOMIC_PENDING_FAILED");
  // Row lock + idempotent completed branch.
  assertStringIncludes(code, "FOR UPDATE");
  assertStringIncludes(code, "v_already_completed");
  // Never relaxes guards.
  assert(!/DISABLE\s+TRIGGER|session_replication_role|ROW\s+LEVEL\s+SECURITY|DROP\s+POLICY/i.test(code));
});

Deno.test("draft tip window matches tipWindowConstants and is never reopened", () => {
  const code = stripSqlComments(read(DRAFT_REL));
  assertEquals(TIP_WINDOW_MS, 20 * 60 * 1000);
  assertStringIncludes(code, "interval '20 minutes'");
  assertStringIncludes(code, "already_stamped_kept");
  assertStringIncludes(code, "skipped_fare_captured");
  assertStringIncludes(code, "'captured', 'paid', 'collected_cash'");
});

Deno.test("draft is service_role only (no anon / authenticated EXECUTE)", () => {
  const code = stripSqlComments(read(DRAFT_REL));
  assertStringIncludes(code, "FROM anon, authenticated");
  assertStringIncludes(code, "TO service_role");
  assert(!/GRANT\s+EXECUTE[^;]*TO\s+(anon|authenticated)/i.test(code));
});

Deno.test("stop-workflow does NOT call the atomic RPC yet (STOP BEFORE PROD)", () => {
  const stop = read("functions/stop-workflow/index.ts");
  assert(!stop.includes(RPC), "stop-workflow must not reference complete_trip_atomic_v1 before cutover");
  // Still the legacy sequential path.
  assertStringIncludes(stop, "creditTripEarningPending(");
  assertStringIncludes(stop, 'case \'complete_trip\'');
});

Deno.test("no edge function or shared module calls the atomic RPC yet", () => {
  const hits: string[] = [];
  const walk = (dir: URL) => {
    for (const e of Deno.readDirSync(dir)) {
      const child = new URL(e.name + (e.isDirectory ? "/" : ""), dir);
      if (e.isDirectory) {
        walk(child);
      } else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) {
        if (Deno.readTextFileSync(child).includes(RPC)) hits.push(child.pathname);
      }
    }
  };
  walk(new URL("functions/", root));
  assertEquals(hits, [], `unexpected ${RPC} callers: ${hits.join(", ")}`);
});

Deno.test("local fixture refuses non-local hosts and never touches prod", () => {
  const sh = read(FIXTURE_REL);
  assertStringIncludes(sh, "REFUSED: host=$HOST is not local");
  assertStringIncludes(sh, "127.0.0.1|localhost");
  assertStringIncludes(sh, "54329");
  assertStringIncludes(sh, "STOP BEFORE PROD");
  assert(!/supabase\.co|pooler\.supabase|db push|supabase db/i.test(sh));
});
