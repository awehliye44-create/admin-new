/**
 * D5 — ingest allowlist must accept O4 transport + journey visible keys.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

const src = await Deno.readTextFile(
  new URL("../../functions/ingest-telemetry/index.ts", import.meta.url),
);

Deno.test("D5 ingest allowlists edge_ttfb_ms / get_session_ms / hard_deadline", () => {
  assertEquals(src.includes('"edge_ttfb_ms"'), true);
  assertEquals(src.includes('"edge_body_parse_ms"'), true);
  assertEquals(src.includes('"edge_fetch_ms"'), true);
  assertEquals(src.includes('"get_session_ms"'), true);
  assertEquals(src.includes('"hard_deadline"'), true);
  assertEquals(src.includes('"searching_visible"'), true);
  assertEquals(src.includes('"authoritative_to_visible_ms"'), true);
});
