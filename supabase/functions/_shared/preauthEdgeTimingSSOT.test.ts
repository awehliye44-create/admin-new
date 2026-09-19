/**
 * Observability-only — preauth Edge timing attaches on every response path.
 */
import { createPreauthEdgeTiming } from "./preauthEdgeTimingSSOT.ts";

Deno.test("preauthEdgeTiming flat fields include edge_total and revolut split", async () => {
  const t = createPreauthEdgeTiming(1_000);
  t.markAuthStart();
  await new Promise((r) => setTimeout(r, 5));
  t.markAuthEnd();
  t.markDbLookupStart();
  t.markDbLookupEnd();
  t.markValidationStart();
  t.markValidationEnd();
  t.markRevolutRequestStart();
  await new Promise((r) => setTimeout(r, 5));
  t.markRevolutRequestEnd();
  t.markRevolutResponseStart();
  await new Promise((r) => setTimeout(r, 5));
  t.markRevolutResponseEnd();
  t.markPersistStart();
  t.markPersistEnd();
  const body = t.attachToBody({ success: true, status: "payment_processing" });
  if (typeof body.edge_total_ms !== "number" || body.edge_total_ms < 10) {
    throw new Error(`edge_total_ms missing/low: ${body.edge_total_ms}`);
  }
  if (body.edge_preauth_server_ms !== body.edge_total_ms) {
    throw new Error("edge_preauth_server_ms alias mismatch");
  }
  if (typeof body.edge_revolut_request_ms !== "number") {
    throw new Error("edge_revolut_request_ms missing");
  }
  if (typeof body.edge_revolut_response_ms !== "number") {
    throw new Error("edge_revolut_response_ms missing");
  }
  if (!body.booking_milestones || typeof body.booking_milestones.hold_duration_ms !== "number") {
    throw new Error("booking_milestones.hold_duration_ms missing on processing path");
  }
});
