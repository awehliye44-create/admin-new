/**
 * Unit tests — Veriff/SDK done must never imply approved; mapping + idempotency helpers.
 */
import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { mapProviderDecisionPayload } from "./mapDecision.ts";
import { mapInternalStatusToAppFacing } from "./types.ts";

Deno.test("approved maps to approved", () => {
  assertEquals(
    mapProviderDecisionPayload({
      status: "approved",
      providerSessionId: "s1",
    }),
    "approved",
  );
});

Deno.test("resubmission_requested maps to retry_required", () => {
  assertEquals(
    mapProviderDecisionPayload({
      status: "resubmission_requested",
      providerSessionId: "s1",
    }),
    "retry_required",
  );
});

Deno.test("review maps to manual_review", () => {
  assertEquals(
    mapProviderDecisionPayload({ status: "review", providerSessionId: "s1" }),
    "manual_review",
  );
});

Deno.test("declined respects SA review policy", () => {
  assertEquals(
    mapProviderDecisionPayload({
      status: "declined",
      providerSessionId: "s1",
      declinedMapsTo: "manual_review",
    }),
    "manual_review",
  );
  assertEquals(
    mapProviderDecisionPayload({
      status: "declined",
      providerSessionId: "s1",
    }),
    "rejected",
  );
});

Deno.test("abandoned maps to cancelled (session context may remint retry)", () => {
  assertEquals(
    mapProviderDecisionPayload({
      status: "abandoned",
      providerSessionId: "s1",
    }),
    "cancelled",
  );
});

Deno.test("SDK-ish finished/done never maps to approved", () => {
  assertEquals(
    mapProviderDecisionPayload({
      status: "done",
      providerSessionId: "s1",
    }),
    "manual_review",
  );
  assertEquals(
    mapProviderDecisionPayload({
      status: "finished",
      providerSessionId: "s1",
    }),
    "manual_review",
  );
  assertEquals(
    mapProviderDecisionPayload({
      status: "submitted",
      providerSessionId: "s1",
    }),
    "manual_review",
  );
});

Deno.test("app facing map does not treat processing as approved", () => {
  assertEquals(mapInternalStatusToAppFacing("processing"), "checking");
  assertEquals(mapInternalStatusToAppFacing("started"), "checking");
  assertEquals(mapInternalStatusToAppFacing("approved"), "approved");
  assertEquals(
    mapInternalStatusToAppFacing("reference_unavailable"),
    "reference_unavailable",
  );
});
