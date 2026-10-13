/**
 * Lock: completed and terminal trips cannot be cancelled, reopened or given a
 * cancellation financial outcome (MK-260923-017, MK-260916-029/030,
 * MK-261003-003). If this fails, fix the code — never delete or soften the lock.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname ?? __dirname, "../../..");

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

function requireAll(rel: string, needles: string[]) {
  const src = read(rel);
  for (const n of needles) {
    if (!src.includes(n)) throw new Error(`${rel} missing: ${n}`);
  }
  return src;
}

function countOf(src: string, needle: string): number {
  return src.split(needle).length - 1;
}

Deno.test("late-cancellation-check authenticates the caller and never trusts body cancelled_by", () => {
  const src = requireAll("supabase/functions/late-cancellation-check/index.ts", [
    "assertServiceRole(",
    "requireAuthenticatedUser(",
    "authoriseLateCancellationCaller({",
    "const cancelled_by = authz.cancelledBy;",
    '.is("completed_at", null)',
    '.not("status", "in", TERMINAL_TRIP_STATUS_POSTGREST_LIST)',
    "buildCancelledScheduledStatePatch(",
    "TRIP_TERMINAL",
  ]);
  if (/\{[^}]*\bcancelled_by\b[^}]*\}\s*=\s*body\b/.test(src) || /cancelled_by\s*=\s*body\.cancelled_by/.test(src)) {
    throw new Error("late-cancellation-check writes the request body cancelled_by");
  }
  if (countOf(src, "if (!cancelled) return terminalConflict();") < 2) {
    throw new Error("late-cancellation-check must stop before settlement when the guarded cancel matched no row");
  }
});

Deno.test("admin-trip-actions refuses completed trips and audits the acting admin", () => {
  requireAll("supabase/functions/admin-trip-actions/index.ts", [
    "COMPLETED_TRIP_NOT_CANCELLABLE",
    "TERMINAL_STATE_LOCKED",
    'writeAdminAudit("ADMIN_TRIP_CANCEL_REFUSED"',
    'writeAdminAudit("ADMIN_TRIP_CANCELLED"',
    "user_id: userId",
  ]);
});

Deno.test("record-financial-outcome checks driver entitlement before posting", () => {
  const src = requireAll("supabase/functions/record-financial-outcome/index.ts", [
    "evaluateFinancialOutcomeEntitlement({",
    "completed_at",
    "previous_driver_id",
    "arrived_at",
  ]);
  const guardAt = src.indexOf("evaluateFinancialOutcomeEntitlement({");
  const postAt = src.indexOf("postTerminalOutcomeSettlement({");
  if (postAt < 0 || postAt < guardAt) {
    throw new Error("record-financial-outcome must evaluate entitlement before postTerminalOutcomeSettlement");
  }
});

Deno.test("dispatch writers never reopen a completed or terminal trip", () => {
  const minimum: Record<string, number> = {
    "supabase/functions/auto-dispatch/index.ts": 3,
    "supabase/functions/_shared/scheduleDispatchConversionSweep.ts": 3,
    "supabase/functions/scheduled-dispatch/index.ts": 8,
    "supabase/functions/decline-offer/index.ts": 1,
  };
  for (const [rel, n] of Object.entries(minimum)) {
    const src = read(rel);
    const guarded = countOf(src, '.not("status", "in", TERMINAL_TRIP_STATUS_POSTGREST_LIST)');
    if (guarded < n) throw new Error(`${rel}: ${guarded} terminal-guarded writes, expected >= ${n}`);
  }
});

Deno.test("Scheduled Rides admin actions carry the terminal predicate", () => {
  const src = read("src/pages/ScheduledRides.tsx");
  if (countOf(src, ".not('status', 'in', TERMINAL_TRIP_STATUS_FILTER)") < 6) {
    throw new Error("ScheduledRides status/release writes must exclude terminal trips");
  }
  if (!src.includes("(completed,cancelled,canceled,customer_cancelled")) {
    throw new Error("ScheduledRides terminal filter must include completed and cancelled statuses");
  }
});

Deno.test("terminal state DB lock migration keeps its invariants", () => {
  requireAll("supabase/migrations/20261216200000_terminal_trip_state_lock.sql", [
    "CREATE TRIGGER zz_enforce_trip_terminal_state_lock",
    "BEFORE UPDATE ON public.trips",
    "'COMPLETED_TRIP_STATUS_CHANGE'",
    "'COMPLETED_AT_CLEARED'",
    "'TERMINAL_TRIP_REOPENED'",
    "RAISE EXCEPTION 'TERMINAL_STATE_LOCKED:",
    "'TERMINAL_STATE_OVERRIDE'",
    "current_user IN ('service_role', 'postgres', 'supabase_admin')",
    "'COMPLETED_TRIP_NOT_CANCELLABLE'",
    "AND completed_at IS NULL",
  ]);
  requireAll("supabase/migrations/rollback/rollback_20261216200000_terminal_trip_state_lock.sql", [
    "DROP TRIGGER IF EXISTS zz_enforce_trip_terminal_state_lock",
  ]);
});
