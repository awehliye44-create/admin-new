/**
 * #92L / #97 — Admin tips_enabled toggle vs tip-window lifecycle.
 */
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  TIP_WINDOW_ADMIN_TOGGLE_POLICY,
  mayOpenTipWindowForCompletion,
  openTipWindowRemainsActiveAfterAdminToggle,
} from "./tipWindowAdminToggleSSOT.ts";

Deno.test("#92L tip window opens only when tips_enabled at complete", () => {
  assertEquals(mayOpenTipWindowForCompletion({ tipsEnabledAtComplete: true }), true);
  assertEquals(mayOpenTipWindowForCompletion({ tipsEnabledAtComplete: false }), false);
  assert(TIP_WINDOW_ADMIN_TOGGLE_POLICY.stampAtCompleteFromTipsEnabled);
  assert(TIP_WINDOW_ADMIN_TOGGLE_POLICY.openWindowSurvivesTipsDisabled);
  assert(TIP_WINDOW_ADMIN_TOGGLE_POLICY.noRetroactiveWindowAfterComplete);
  assert(TIP_WINDOW_ADMIN_TOGGLE_POLICY.neverReopenCapturedOrderForTip);
});

Deno.test("#92L open tip window survives Admin tips OFF", () => {
  const now = Date.now();
  assertEquals(
    openTipWindowRemainsActiveAfterAdminToggle({
      tipWindowOpenedAt: new Date(now - 60_000).toISOString(),
      tipWindowClosedAt: null,
      tipWindowExpiresAt: new Date(now + 600_000).toISOString(),
      tipsEnabledNow: false,
      nowMs: now,
    }),
    true,
  );
  assertEquals(
    openTipWindowRemainsActiveAfterAdminToggle({
      tipWindowOpenedAt: new Date(now - 60_000).toISOString(),
      tipWindowClosedAt: new Date(now - 1).toISOString(),
      tipWindowExpiresAt: new Date(now + 600_000).toISOString(),
      tipsEnabledNow: true,
      nowMs: now,
    }),
    false,
  );
  assertEquals(
    openTipWindowRemainsActiveAfterAdminToggle({
      tipWindowOpenedAt: null,
      tipWindowClosedAt: null,
      tipWindowExpiresAt: new Date(now + 600_000).toISOString(),
      tipsEnabledNow: true,
      nowMs: now,
    }),
    false,
  );
});

Deno.test("#92L customer_get_my_trip migration exposes tip eligibility SSOT fields", async () => {
  const mig = await Deno.readTextFile(
    new URL(
      "../../migrations/20270301160000_customer_get_my_trip_tip_eligibility_92l.sql",
      import.meta.url,
    ),
  );
  for (const col of [
    "booking_source",
    "corporate_account_id",
    "financial_model",
    "service_area_id",
    "currency_code",
    "tip_window_opened_at",
    "tip_window_expires_at",
    "tip_window_closed_at",
    "tip_window_status",
  ]) {
    assert(mig.includes(`tr.${col}`), `migration must select ${col}`);
  }
});

Deno.test("#92L CTAP idempotent paths ensure booking payable snapshot", async () => {
  const ctap = await Deno.readTextFile(
    new URL("../../functions/create-trip-after-payment/index.ts", import.meta.url),
  );
  assert(ctap.includes("ensureBookingSnapOnIdempotent"));
  assert(ctap.includes("#92L — Every PC success path"));
  // Early idempotent short-circuit + duplicate-insert races must call ensure.
  const ensureDef = ctap.indexOf("const ensureBookingSnapOnIdempotent");
  const earlyIdempotent = ctap.indexOf("Idempotent — trip already exists");
  const firstEnsureCall = ctap.indexOf("await ensureBookingSnapOnIdempotent(", ensureDef + 1);
  assert(ensureDef > 0 && earlyIdempotent > ensureDef);
  assert(firstEnsureCall > earlyIdempotent, "early idempotent path must ensure booking snap");
  const occurrences = ctap.split("await ensureBookingSnapOnIdempotent(").length - 1;
  assert(occurrences >= 5, `expected ≥5 ensure calls, got ${occurrences}`);
});

Deno.test("#92L integrity recovery fills booking gap while tip window defers capture", async () => {
  const recovery = await Deno.readTextFile(
    new URL(
      "../../functions/sweep-revolut-stale-holds/lib/platformCollectedFinancialIntegrityRecoverySSOT.ts",
      import.meta.url,
    ),
  );
  assert(recovery.includes("not_captured_or_authorised"));
  assert(recovery.includes("capture_requested"));
  assert(recovery.includes("authorized"));
  assert(recovery.includes("isCaptured && capturedPence > 0"));
  assert(recovery.includes("Completion/recovery snap only after confirmed capture"));
});
