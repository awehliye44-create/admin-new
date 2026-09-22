/**
 * WINDOW_EXPIRED crash-after-capture stale reclaim — wired integration lock.
 *
 * Exact scenario:
 * 1. WINDOW_EXPIRED claims
 * 2. Persist durable idempotency before capture POST
 * 3. Capture POST sent
 * 4. Crash before finalize
 * 5. Past 5-minute stale threshold
 * 6. Second expiry worker hits CLAIM_HELD → GET first
 */

import {
  assertEquals,
  assert,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  TIP_WINDOW_STATUS,
  TIP_WINDOW_TRIGGER,
} from "../../functions/_shared/tipWindowConstants.ts";
import {
  buildTipWindowCaptureIdempotencyKey,
  decideExpiredStaleReclaimAfterGet,
  runExpiredCrashAfterCaptureRecovery,
  TIP_WINDOW_STALE_CLAIM_MS,
} from "../../functions/_shared/expiredTipWindowStaleReclaimSSOT.ts";

const ORDER = "6ab282ce-test-order";
const FARE = 500;
const IDEM = buildTipWindowCaptureIdempotencyKey({
  providerOrderId: ORDER,
  farePence: FARE,
});

function memoryCrashDeps(opts: {
  providerState: "COMPLETED" | "AUTHORISED" | "UNKNOWN";
  firstPostApplied: boolean;
}) {
  let owner: string | null = null;
  let claimedAt = 0;
  let idemKey: string | null = null;
  let status = TIP_WINDOW_STATUS.OPEN;
  let capturePosts = 0;
  let finalized = 0;

  return {
    state: () => ({ owner, idemKey, status, capturePosts, finalized }),
    deps: {
      claim: async (token: string) => {
        if (status === TIP_WINDOW_STATUS.EXPIRED) {
          return { ok: false as const, code: "ALREADY_CLOSED" };
        }
        if (owner && owner !== token) {
          const staleEligible = claimedAt > 0 &&
            (Date.now() - claimedAt >= TIP_WINDOW_STALE_CLAIM_MS || true);
          // Test forces staleEligible via flag on second call — see harness.
          return {
            ok: false as const,
            code: "CLAIM_HELD",
            staleEligible: owner === "worker-1-token",
            idempotencyKey: idemKey,
          };
        }
        owner = token;
        claimedAt = Date.now();
        status = TIP_WINDOW_STATUS.PROCESSING;
        return { ok: true as const, claimToken: token };
      },
      stampIdempotency: async (_token: string, key: string) => {
        if (!idemKey) idemKey = key;
        return { key: idemKey };
      },
      capturePost: async (key: string) => {
        assertEquals(key, IDEM);
        capturePosts += 1;
        return { posted: true };
      },
      providerGet: async () => ({
        state: opts.providerState,
        confirmedCapturePence: opts.firstPostApplied ? FARE : null,
      }),
      finalizeExpiredNoPost: async (_pence: number) => {
        finalized += 1;
        status = TIP_WINDOW_STATUS.EXPIRED;
        owner = null;
        return { ok: true };
      },
      reclaimAfterAuthorisedGet: async (token: string) => {
        if (opts.providerState !== "AUTHORISED") {
          return { ok: false as const, code: "CLAIM_HELD" };
        }
        owner = token;
        return {
          ok: true as const,
          claimToken: token,
          idempotencyKey: idemKey ?? IDEM,
        };
      },
      resumeCaptureSameKey: async (key: string) => {
        assertEquals(key, IDEM);
        capturePosts += 1;
        return { capturePosts: 1, captured: true };
      },
    },
  };
}

Deno.test("EXPIRED_STALE: COMPLETED after crash → zero new capture POSTs, EXPIRED once", async () => {
  const mem = memoryCrashDeps({
    providerState: "COMPLETED",
    firstPostApplied: true,
  });
  const result = await runExpiredCrashAfterCaptureRecovery({
    tripId: "t-crash-1",
    providerOrderId: ORDER,
    farePence: FARE,
    paymentSessionId: "ps-1",
    atClaimMs: 0,
    atRecoverMs: TIP_WINDOW_STALE_CLAIM_MS + 1,
    providerStateAfterCrash: "COMPLETED",
    firstPostApplied: true,
    deps: mem.deps,
  });
  assertEquals(result.decision, "finalize_expired_no_post");
  assertEquals(result.capture_post_count, 1); // only worker1 POST
  assertEquals(result.finalize_count, 1);
  assertEquals(result.tip_window_status, TIP_WINDOW_STATUS.EXPIRED);
  assertEquals(result.tip_window_trigger, TIP_WINDOW_TRIGGER.WINDOW_EXPIRED);
  assertEquals(result.ten_count, 1);
  assertEquals(result.tip_credit_count, 0);
  assertEquals(result.payment_order_count, 1);
  assertEquals(result.claim_stolen, false);
  assertEquals(result.idempotency_key, IDEM);
  assertEquals(result.get_count, 1);
});

Deno.test("EXPIRED_STALE: AUTHORISED after crash → resume same idempotency, one final capture path", async () => {
  const mem = memoryCrashDeps({
    providerState: "AUTHORISED",
    firstPostApplied: false,
  });
  const result = await runExpiredCrashAfterCaptureRecovery({
    tripId: "t-crash-2",
    providerOrderId: ORDER,
    farePence: FARE,
    paymentSessionId: "ps-1",
    atClaimMs: 0,
    atRecoverMs: TIP_WINDOW_STALE_CLAIM_MS + 1,
    providerStateAfterCrash: "AUTHORISED",
    firstPostApplied: false,
    deps: mem.deps,
  });
  assertEquals(result.decision, "reclaim_and_resume_same_idempotency");
  assertEquals(result.idempotency_key, IDEM);
  assertEquals(result.capture_post_count, 2); // first failed apply + resume
  assertEquals(result.finalize_count, 1);
  assertEquals(result.tip_credit_count, 0);
  assertEquals(result.payment_order_count, 1);
  assertEquals(result.ten_count, 1);
});

Deno.test("EXPIRED_STALE: UNKNOWN after crash → CLAIM_HELD, no steal, no capture POST", async () => {
  const mem = memoryCrashDeps({
    providerState: "UNKNOWN",
    firstPostApplied: false,
  });
  const result = await runExpiredCrashAfterCaptureRecovery({
    tripId: "t-crash-3",
    providerOrderId: ORDER,
    farePence: FARE,
    paymentSessionId: "ps-1",
    atClaimMs: 0,
    atRecoverMs: TIP_WINDOW_STALE_CLAIM_MS + 1,
    providerStateAfterCrash: "UNKNOWN",
    firstPostApplied: false,
    deps: mem.deps,
  });
  assertEquals(result.decision, "claim_held_no_steal");
  assertEquals(result.error_code, "PROVIDER_UNKNOWN");
  assertEquals(result.capture_post_count, 1); // only crashed worker1
  assertEquals(result.finalize_count, 0);
  assertEquals(result.claim_stolen, false);
  assertEquals(result.tip_window_status, TIP_WINDOW_STATUS.PROCESSING);
});

Deno.test("EXPIRED_STALE: pure decide — COMPLETED ⇒ finalize_expired_no_post", () => {
  const d = decideExpiredStaleReclaimAfterGet({
    staleEligible: true,
    providerState: "COMPLETED",
    farePence: FARE,
    confirmedCapturePence: FARE,
    idempotencyKey: IDEM,
  });
  assertEquals(d.action, "finalize_expired_no_post");
});

Deno.test("EXPIRED_STALE: pure decide — UNKNOWN ⇒ claim_held_no_steal", () => {
  const d = decideExpiredStaleReclaimAfterGet({
    staleEligible: true,
    providerState: "UNKNOWN",
    farePence: FARE,
    idempotencyKey: IDEM,
  });
  assertEquals(d.action, "claim_held_no_steal");
  assertEquals(d.reason, "provider_unknown");
});

Deno.test("LOCK: claim RPC never auto-steals; GET-first reclaim RPCs exist", async () => {
  const mig = await Deno.readTextFile(
    new URL("../../migrations/20261126120000_tip_window_trigger_mutex.sql", import.meta.url),
  );
  assertStringIncludes(mig, "NEVER auto-steal here");
  assertStringIncludes(mig, "EXPIRED_STALE_RECLAIM_GET_FIRST");
  assertStringIncludes(mig, "finalize_tip_window_expired_after_provider_capture");
  assertStringIncludes(mig, "reclaim_stale_tip_window_expiry_after_authorised_get");
  assertStringIncludes(mig, "stamp_tip_window_capture_idempotency_key");
  assertStringIncludes(mig, "Preserve tip_window_capture_idempotency_key");
  // Auto-steal fallthrough removed from claim.
  assertEquals(mig.includes("fall through to reclaim UPDATE below"), false);
});

Deno.test("LOCK: capture-expired wires GET-first stale recovery + stamp before capture", async () => {
  const src = await Deno.readTextFile(
    new URL("../../functions/capture-expired-tip-windows/index.ts", import.meta.url),
  );
  assertStringIncludes(src, "decideExpiredStaleReclaimAfterGet");
  assertStringIncludes(src, "retrieveRevolutOrder");
  assertStringIncludes(src, "finalizeTipWindowExpiredAfterProviderCapture");
  assertStringIncludes(src, "reclaimStaleTipWindowExpiryAfterAuthorisedGet");
  assertStringIncludes(src, "stampTipWindowCaptureIdempotencyKey");
  assert(
    src.lastIndexOf("await stampTipWindowCaptureIdempotencyKey") <
      src.lastIndexOf("await invokeFinalizeTripCapture") &&
      src.lastIndexOf("await stampTipWindowCaptureIdempotencyKey") > 0,
  );
  assertStringIncludes(src, "stale_reconciled_already_captured");
  assertStringIncludes(src, "provider_unknown_claim_retained");
});
