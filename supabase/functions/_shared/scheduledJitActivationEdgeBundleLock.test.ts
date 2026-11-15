/**
 * Bug #29 lock — JIT / Phase-5 shared modules must be static imports.
 *
 * Dynamic import("../_shared/scheduledJourneyComplianceGate.ts") (and
 * scheduledDepartureAckRescueGateSSOT) omitted the files from the Supabase
 * Edge eszip → scheduled-dispatch returned HTTP 500 Module not found every
 * minute, so confirmed JIT never armed (MK-261115-002).
 */
import { assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/from_file_url.ts";
import { join } from "https://deno.land/std@0.224.0/path/join.ts";

const REPO = fromFileUrl(new URL("../../..", import.meta.url));

const SHARED = [
  "supabase/functions/_shared/scheduledJourneyComplianceGate.ts",
  "supabase/functions/_shared/scheduledDepartureAckRescueGateSSOT.ts",
] as const;

const MUST_STATIC_JOURNEY = [
  "supabase/functions/scheduled-dispatch/index.ts",
  "supabase/functions/scheduled-ride-action/index.ts",
  "supabase/functions/admin-scheduled-ride-action/index.ts",
  "supabase/functions/_shared/scheduledActivationExclusiveRescue.ts",
] as const;

const MUST_STATIC_RESCUE_GATE = [
  "supabase/functions/scheduled-dispatch/index.ts",
  "supabase/functions/expire-offers/index.ts",
] as const;

function stripComments(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

Deno.test("Bug #29: JIT shared modules exist for Edge bundling", async () => {
  for (const rel of SHARED) {
    const st = await Deno.stat(join(REPO, rel));
    assert(st.isFile, `${rel} missing`);
  }
});

Deno.test("Bug #29: journey compliance is a static import (not dynamic)", async () => {
  for (const rel of MUST_STATIC_JOURNEY) {
    const src = stripComments(await Deno.readTextFile(join(REPO, rel)));
    assert(
      src.includes('from "./scheduledJourneyComplianceGate.ts"') ||
        src.includes('from "../_shared/scheduledJourneyComplianceGate.ts"'),
      `${rel} must statically import scheduledJourneyComplianceGate`,
    );
    assert(
      !/await\s+import\(\s*["'](\.\/|\.\.\/_shared\/)scheduledJourneyComplianceGate\.ts["']\s*\)/
        .test(src),
      `${rel} must not dynamically import scheduledJourneyComplianceGate`,
    );
  }
});

Deno.test("Bug #29: departure-ack rescue gate is a static import (not dynamic)", async () => {
  for (const rel of MUST_STATIC_RESCUE_GATE) {
    const src = stripComments(await Deno.readTextFile(join(REPO, rel)));
    assert(
      src.includes('from "../_shared/scheduledDepartureAckRescueGateSSOT.ts"') ||
        src.includes('from "./scheduledDepartureAckRescueGateSSOT.ts"'),
      `${rel} must statically import scheduledDepartureAckRescueGateSSOT`,
    );
    assert(
      !/await\s+import\(\s*["'](\.\/|\.\.\/_shared\/)scheduledDepartureAckRescueGateSSOT\.ts["']\s*\)/
        .test(src),
      `${rel} must not dynamically import scheduledDepartureAckRescueGateSSOT`,
    );
  }
});

Deno.test("Bug #29: confirmed JIT candidate lookback is not 30 minutes", async () => {
  const raw = await Deno.readTextFile(
    join(REPO, "supabase/functions/scheduled-dispatch/index.ts"),
  );
  // STEP 1 confirmed JIT block must keep a 6h past window (STEP 2 unclaimed may stay 30m).
  const step1 = raw.slice(
    raw.indexOf("STEP 1: PRE-CONFIRMED JIT ACTIVATION"),
    raw.indexOf("STEP 1z:"),
  );
  assert(step1.length > 100, "STEP 1 JIT block not found");
  assert(
    !/\.gt\(\s*["']scheduled_at["']\s*,\s*new Date\(\s*nowMs\s*-\s*30\s*\*\s*60_000/.test(
      step1,
    ),
    "STEP 1 must not use 30-minute past lookback for confirmed JIT",
  );
  assert(
    /\.gt\(\s*["']scheduled_at["']\s*,\s*new Date\(\s*nowMs\s*-\s*6\s*\*\s*60\s*\*\s*60_000/.test(
      step1,
    ),
    "STEP 1 expected bounded 6h past lookback for overdue confirmed JIT",
  );
});

Deno.test("Bug #29: JIT pass isolates per-trip failures", async () => {
  const src = stripComments(
    await Deno.readTextFile(
      join(REPO, "supabase/functions/_shared/runConfirmedJitActivationPass.ts"),
    ),
  );
  assert(src.includes("per-trip failure isolated"));
  assert(src.includes("scheduled_jit_overdue_unactivated:"));
  assert(src.includes("SCHEDULED_JIT_ARM_CAS_FAILED"));
  assert(src.includes("scheduled_jit_arm_cas_failed:"));
});

Deno.test("Bug #29: exclusive rescue statically imports eligibility + journey gate", async () => {
  const src = stripComments(
    await Deno.readTextFile(
      join(
        REPO,
        "supabase/functions/_shared/scheduledActivationExclusiveRescue.ts",
      ),
    ),
  );
  assert(src.includes('from "./rideOfferDriverEligibility.ts"'));
  assert(
    !/await\s+import\(\s*["']\.\/rideOfferDriverEligibility\.ts["']\s*\)/.test(
      src,
    ),
  );
  assert(src.includes('from "./scheduledJourneyComplianceGate.ts"'));
});

Deno.test("Bug #29: scheduled-dispatch top-level HTTP 500 ops alert", async () => {
  const src = stripComments(
    await Deno.readTextFile(
      join(REPO, "supabase/functions/scheduled-dispatch/index.ts"),
    ),
  );
  assert(src.includes("scheduled_dispatch_http_500"));
  assert(src.includes("upsertScheduledJitOpsAlert"));
});

Deno.test("Bug #29: JIT ops alerts include NOT NULL category/severity/source", async () => {
  const helper = stripComments(
    await Deno.readTextFile(
      join(REPO, "supabase/functions/_shared/scheduledJitOpsAlertSSOT.ts"),
    ),
  );
  assert(helper.includes('category: input.category ?? "dispatch"'));
  assert(helper.includes('severity: input.severity ?? "warning"'));
  assert(helper.includes('source: "edge_function"'));

  const pass = stripComments(
    await Deno.readTextFile(
      join(REPO, "supabase/functions/_shared/runConfirmedJitActivationPass.ts"),
    ),
  );
  assert(pass.includes("upsertScheduledJitOpsAlert"));
  // Incomplete raw upserts (missing category) must not remain in the JIT pass.
  assert(!/from\("ops_alerts"\)\.upsert\(/.test(pass));
});

Deno.test("Bug #29: buildScheduledJitOpsAlertRow is deploy-safe", async () => {
  const { buildScheduledJitOpsAlertRow } = await import(
    "./scheduledJitOpsAlertSSOT.ts"
  );
  const row = buildScheduledJitOpsAlertRow({
    fingerprint: "scheduled_dispatch_http_500",
    title: "scheduled-dispatch HTTP 500",
    severity: "critical",
    metadata: { module_not_found: true },
  });
  assert(row.category === "dispatch");
  assert(row.severity === "critical");
  assert(row.source === "edge_function");
  assert(row.status === "open");
  assert(row.fingerprint === "scheduled_dispatch_http_500");
});
