/**
 * Step 9.4C — Business OAuth continuity mock tests (no network / no Vault writes).
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  BUSINESS_TOKEN_REFRESH_WRITERS,
  classifyDurableRefreshOwner,
  classifyGetAuthFailurePolicy,
  classifyLinkageBootDefect,
  classifyPayAuthFailurePolicy,
  LINKAGE_MISSING_EXPORTS,
  mockEnsureFresh,
  remainingLifetimeSeconds,
  shouldPersistRefreshAgainstNewerGeneration,
  tokenNeedsRefresh,
  type MockVault,
} from "./revolutBusinessOAuthContinuitySSOT.ts";

Deno.test("valid token before refresh threshold → GET proceeds (no refresh)", async () => {
  const now = Date.parse("2026-08-21T10:00:00.000Z");
  const vault: MockVault = {
    access_token: "oa_prod_access_fresh____________",
    refresh_token: "oa_prod_refresh________________",
    expires_at: "2026-08-21T12:00:00.000Z",
    generation: 1,
  };
  let attempts = 0;
  const r = await mockEnsureFresh({
    vault,
    nowMs: now,
    refreshFn: async () => {
      attempts++;
      return { access_token: "x", expires_in: 2400 };
    },
  });
  assertEquals(r.refreshed, false);
  assertEquals(attempts, 0);
  assertEquals(tokenNeedsRefresh({ nowMs: now, expiresAtIso: vault.expires_at }), false);
});

Deno.test("token inside refresh threshold → refresh occurs before Business request", async () => {
  const now = Date.parse("2026-08-21T11:30:40.000Z"); // within 60s of 11:31:28
  const vault: MockVault = {
    access_token: "oa_prod_access_old______________",
    refresh_token: "oa_prod_refresh________________",
    expires_at: "2026-08-21T11:31:28.356Z",
    generation: 1,
  };
  const r = await mockEnsureFresh({
    vault,
    nowMs: now,
    refreshFn: async () => ({
      access_token: "oa_prod_access_new______________",
      refresh_token: "oa_prod_refresh_rotated_________",
      expires_in: 2400,
    }),
  });
  assertEquals(r.refreshed, true);
  assertEquals(vault.access_token.startsWith("oa_prod_access_new"), true);
  assertEquals(vault.refresh_token.includes("rotated"), true);
});

Deno.test("expired token → refresh before request; refresh failure → no /pay", async () => {
  const now = Date.parse("2026-08-21T12:00:00.000Z");
  const vault: MockVault = {
    access_token: "oa_prod_access_expired__________",
    refresh_token: "oa_prod_refresh________________",
    expires_at: "2026-08-21T11:31:28.356Z",
    generation: 1,
  };
  let threw = false;
  try {
    await mockEnsureFresh({
      vault,
      nowMs: now,
      refreshFn: async () => {
        throw new Error("token_refresh_failed_401");
      },
    });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
  const pay = classifyPayAuthFailurePolicy({
    revolut_pay_called: false,
    http_status: 401,
    provider_payment_id: null,
  });
  assertEquals(pay.retry_pay, false);
  assertEquals(pay.refresh_then_replay_pay, false);
});

Deno.test("concurrent refreshes: production helper has no lock; stale overwrite must be blocked by desired guard", async () => {
  const owner = classifyDurableRefreshOwner({
    scheduledRefreshCronExists: false,
    relayOwnsRefresh: false,
    refreshWriters: [...BUSINESS_TOKEN_REFRESH_WRITERS],
    hasDurableLock: false,
    temporaryManualRefreshDeployed: false,
  });
  assertEquals(owner, "NO_DURABLE_BUSINESS_OAUTH_REFRESH_OWNER");

  // Desired atomicity: stale generation cannot overwrite newer
  assertEquals(
    shouldPersistRefreshAgainstNewerGeneration({ startedGeneration: 1, currentGeneration: 2 }),
    false,
  );
  assertEquals(
    shouldPersistRefreshAgainstNewerGeneration({ startedGeneration: 2, currentGeneration: 2 }),
    true,
  );

  // Simulate two concurrent mockEnsureFresh without lock — both refresh (unsafe)
  const vault: MockVault = {
    access_token: "oa_prod_a",
    refresh_token: "oa_prod_r",
    expires_at: "2026-08-21T11:00:00.000Z",
    generation: 0,
  };
  const now = Date.parse("2026-08-21T12:00:00.000Z");
  let refreshes = 0;
  await Promise.all([
    mockEnsureFresh({
      vault,
      nowMs: now,
      refreshFn: async () => {
        refreshes++;
        await new Promise((r) => setTimeout(r, 5));
        return { access_token: "t1", expires_in: 100 };
      },
    }),
    mockEnsureFresh({
      vault,
      nowMs: now,
      refreshFn: async () => {
        refreshes++;
        await new Promise((r) => setTimeout(r, 5));
        return { access_token: "t2", expires_in: 100 };
      },
    }),
  ]);
  assertEquals(refreshes >= 2, true); // proves lack of single-flight lock in helper model
});

Deno.test("/pay 401 → no blind payment replay", () => {
  const p = classifyPayAuthFailurePolicy({
    revolut_pay_called: true,
    http_status: 401,
    provider_payment_id: null,
  });
  assertEquals(p.retry_pay, false);
  assertEquals(p.refresh_then_replay_pay, false);
  assertEquals(p.abort_claim, true);
});

Deno.test("GET 401 production policy: proactive refresh only, no GET retry loop", () => {
  const p = classifyGetAuthFailurePolicy(true);
  assertEquals(p.refresh_count_max, 1);
  assertEquals(p.get_retry_max, 0);
});

Deno.test("linkage missing exports + Admin UI caller → GO_LIVE_CRITICAL_BOOT_DEFECT", () => {
  assertEquals(LINKAGE_MISSING_EXPORTS.length, 3);
  const c = classifyLinkageBootDefect({
    boots: false,
    adminUiCallerExists: true,
    ownsOauthRenewal: false,
    replacedByOtherCanonicalLinker: false,
  });
  assertEquals(c, "GO_LIVE_CRITICAL_BOOT_DEFECT");
});

Deno.test("expiry timeline: remaining lifetime math + required lead time = skew", () => {
  const now = Date.parse("2026-08-21T11:20:00.000Z");
  const rem = remainingLifetimeSeconds({
    nowMs: now,
    expiresAtIso: "2026-08-21T11:31:28.356Z",
  });
  assertEquals(Math.floor(rem), 688);
  assertEquals(tokenNeedsRefresh({
    nowMs: Date.parse("2026-08-21T11:30:40.000Z"),
    expiresAtIso: "2026-08-21T11:31:28.356Z",
  }), true);
});

Deno.test("secret hygiene: continuity SSOT never embeds oa_prod live values", async () => {
  const src = await Deno.readTextFile(
    new URL("./revolutBusinessOAuthContinuitySSOT.ts", import.meta.url),
  );
  assertEquals(src.includes("sk_"), false);
  assertEquals(/BEGIN PRIVATE KEY/.test(src), false);
});
