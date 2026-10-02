/**
 * Phase 6 instrumentation only. The pre-write read group and the existing
 * outside-handler field stay. Ingest accepts the new split fields.
 */
import { assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";

const revolut = await Deno.readTextFile(new URL("./revolutPreauth.ts", import.meta.url));
const ingest = await Deno.readTextFile(new URL("../ingest-telemetry/index.ts", import.meta.url));

Deno.test("phase 5 pre-write join and outside-handler fields stay", () => {
  const fn = revolut.slice(revolut.indexOf("export async function createRevolutPreauthResponse"));
  assertStringIncludes(fn, "merchantP,\n    sessionP,\n    ledgerP,\n    quoteRevalidateP,");
  assertStringIncludes(ingest, "client_preauth_outside_handler_ms");
  assertStringIncludes(ingest, "client_preauth_invoke_ms");
  assertStringIncludes(ingest, "client_preauth_headers_ms");
  assertStringIncludes(ingest, "client_preauth_body_ms");
  assertStringIncludes(ingest, "client_preauth_parse_ms");
  assertStringIncludes(ingest, "client_preauth_server_duration_ms");
  assertStringIncludes(ingest, "client_preauth_pre_response_residual_ms");
  assertStringIncludes(ingest, "client_preauth_post_header_body_ms");
  assertStringIncludes(ingest, "client_preauth_fetch_attempts");
  assertStringIncludes(ingest, "client_preauth_fetch_transport_error");
  assertStringIncludes(ingest, "MAX_METADATA_KEYS = 140");
});
