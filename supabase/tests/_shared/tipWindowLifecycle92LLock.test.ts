/**
 * #92L / #97 — Tip lifecycle architecture locks (Admin → Rate UI → capture).
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  TIP_WINDOW_MS,
  TIP_WINDOW_TRIGGER,
  resolveCustomerTipWindowTrigger,
  tipWindowTerminalStatusForTrigger,
  TIP_WINDOW_STATUS,
} from "../../functions/_shared/tipWindowConstants.ts";
import {
  mayOpenTipWindowForCompletion,
  openTipWindowRemainsActiveAfterAdminToggle,
} from "./tipWindowAdminToggleSSOT.ts";

Deno.test("#92L exactly four tip-window close triggers", () => {
  assertEquals(TIP_WINDOW_MS, 20 * 60 * 1000);
  assertEquals(Object.keys(TIP_WINDOW_TRIGGER).sort(), [
    "CUSTOMER_SKIP",
    "CUSTOMER_SUBMIT_NO_TIP",
    "CUSTOMER_SUBMIT_WITH_TIP",
    "WINDOW_EXPIRED",
  ].sort());
  assertEquals(
    resolveCustomerTipWindowTrigger({ tipAmountPence: 0, skip: true }),
    TIP_WINDOW_TRIGGER.CUSTOMER_SKIP,
  );
  assertEquals(
    resolveCustomerTipWindowTrigger({ tipAmountPence: 0 }),
    TIP_WINDOW_TRIGGER.CUSTOMER_SUBMIT_NO_TIP,
  );
  assertEquals(
    resolveCustomerTipWindowTrigger({ tipAmountPence: 200 }),
    TIP_WINDOW_TRIGGER.CUSTOMER_SUBMIT_WITH_TIP,
  );
  assertEquals(
    tipWindowTerminalStatusForTrigger(TIP_WINDOW_TRIGGER.WINDOW_EXPIRED),
    TIP_WINDOW_STATUS.EXPIRED,
  );
  assertEquals(
    tipWindowTerminalStatusForTrigger(TIP_WINDOW_TRIGGER.CUSTOMER_SKIP),
    TIP_WINDOW_STATUS.CLOSED,
  );
});

Deno.test("#92L tips OFF at complete → no window; tips ON → may open", () => {
  assertEquals(mayOpenTipWindowForCompletion({ tipsEnabledAtComplete: false }), false);
  assertEquals(mayOpenTipWindowForCompletion({ tipsEnabledAtComplete: true }), true);
});

Deno.test("#92L Admin toggle OFF does not invalidate open window", () => {
  const now = Date.now();
  assert(
    openTipWindowRemainsActiveAfterAdminToggle({
      tipWindowOpenedAt: new Date(now - 1_000).toISOString(),
      tipWindowClosedAt: null,
      tipWindowExpiresAt: new Date(now + 60_000).toISOString(),
      tipsEnabledNow: false,
      nowMs: now,
    }),
  );
});

Deno.test("#92L stop-workflow defers capture when tips_enabled stamps window", async () => {
  const stop = await Deno.readTextFile(
    new URL("../../functions/stop-workflow/index.ts", import.meta.url),
  );
  assert(stop.includes("tip_window_capture_deferred"));
  assert(stop.includes("TIP_WINDOW_MS"));
  assert(stop.includes("tips_enabled"));
  assert(stop.includes("tip_window_expires_at"));
});

Deno.test("#92L capture job refuses while tip window open", async () => {
  const job = await Deno.readTextFile(
    new URL("../../functions/_shared/tripCaptureJobSSOT.ts", import.meta.url),
  );
  assert(job.includes('outcome: "tip_window_open"'));
  assert(job.includes("tip_window_expires_at"));
});
