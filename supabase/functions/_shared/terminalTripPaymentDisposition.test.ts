import {
  classifyTerminalHoldDisposition,
} from "./terminalTripPaymentDisposition.ts";

Deno.test("search expired / no driver → void full", () => {
  const r = classifyTerminalHoldDisposition({
    tripStatus: "expired",
    feePence: 0,
    hasProviderOrder: true,
    provider: "revolut",
  });
  if (r.action !== "void_full") throw new Error(JSON.stringify(r));
});

Deno.test("customer cancel searching / no fee → void full", () => {
  const r = classifyTerminalHoldDisposition({
    tripStatus: "cancelled",
    feePence: 0,
    hasProviderOrder: true,
    provider: "revolut",
  });
  if (r.action !== "void_full") throw new Error(JSON.stringify(r));
});

Deno.test("customer cancel with approved fee → partial capture", () => {
  const r = classifyTerminalHoldDisposition({
    tripStatus: "cancelled",
    feePence: 400,
    hasProviderOrder: true,
    provider: "revolut",
  });
  if (r.action !== "partial_capture_fee") throw new Error(JSON.stringify(r));
});

Deno.test("rematch searching_new_driver → skip keep auth", () => {
  const r = classifyTerminalHoldDisposition({
    tripStatus: "searching_new_driver",
    feePence: 0,
    hasProviderOrder: true,
    provider: "revolut",
  });
  if (r.action !== "skip" || r.outcome !== "SKIPPED_REMATCH_OR_ACTIVE") {
    throw new Error(JSON.stringify(r));
  }
});

Deno.test("admin cancel terminal → void full when no fee", () => {
  const r = classifyTerminalHoldDisposition({
    tripStatus: "cancelled",
    feePence: 0,
    hasProviderOrder: true,
    provider: "revolut",
  });
  if (r.action !== "void_full") throw new Error(JSON.stringify(r));
});

Deno.test("completed trip → skip (capture owner unchanged)", () => {
  const r = classifyTerminalHoldDisposition({
    tripStatus: "completed",
    feePence: 0,
    hasProviderOrder: true,
    provider: "revolut",
  });
  if (r.action !== "skip" || r.outcome !== "SKIPPED_COMPLETED") {
    throw new Error(JSON.stringify(r));
  }
});

Deno.test("in progress / assigned → skip", () => {
  for (const status of ["in_progress", "driver_assigned", "en_route_to_pickup", "searching"]) {
    const r = classifyTerminalHoldDisposition({
      tripStatus: status,
      feePence: 0,
      hasProviderOrder: true,
      provider: "revolut",
    });
    if (r.action !== "skip" || r.outcome !== "SKIPPED_REMATCH_OR_ACTIVE") {
      throw new Error(`${status}: ${JSON.stringify(r)}`);
    }
  }
});

Deno.test("missing order → skip", () => {
  const r = classifyTerminalHoldDisposition({
    tripStatus: "cancelled",
    feePence: 0,
    hasProviderOrder: false,
    provider: "revolut",
  });
  if (r.action !== "skip" || r.outcome !== "SKIPPED_NO_ORDER") {
    throw new Error(JSON.stringify(r));
  }
});

Deno.test("customer_cancelled / expired_no_driver terminal → void", () => {
  for (const status of ["customer_cancelled", "expired_no_driver", "no_show"]) {
    const r = classifyTerminalHoldDisposition({
      tripStatus: status,
      feePence: 0,
      hasProviderOrder: true,
      provider: "revolut",
    });
    if (r.action !== "void_full") throw new Error(`${status}: ${JSON.stringify(r)}`);
  }
});

Deno.test("no fee policy → void; fee policy → partial", () => {
  const none = classifyTerminalHoldDisposition({
    tripStatus: "cancelled",
    feePence: 0,
    hasProviderOrder: true,
    provider: "revolut",
  });
  const fee = classifyTerminalHoldDisposition({
    tripStatus: "cancelled",
    feePence: 500,
    hasProviderOrder: true,
    provider: "revolut",
  });
  if (none.action !== "void_full" || fee.action !== "partial_capture_fee") {
    throw new Error(JSON.stringify({ none, fee }));
  }
});
