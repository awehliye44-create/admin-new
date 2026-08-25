#!/usr/bin/env -S deno test --allow-read --allow-write --allow-run
import { assertEquals, assertRejects, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";
import {
  boundaryFromBodyStart,
  detectFormat,
  extractArchive,
  isSafeRelative,
  parseContentTypeHeader,
  readResponseContentType,
  resolveMultipartBoundary,
} from "./step82a5-safe-archive-extract.ts";

const FIX = new URL("./fixtures/step82a5/", import.meta.url);

async function readFixture(name: string): Promise<Uint8Array> {
  return await Deno.readFile(new URL(name, FIX));
}

Deno.test("parseContentTypeHeader reads boundary from response header", () => {
  const ct = parseContentTypeHeader("multipart/form-data; boundary=TestBoundaryStep82A5");
  assertEquals(ct.mediaType, "multipart/form-data");
  assertEquals(ct.boundary, "TestBoundaryStep82A5");
});

Deno.test("readResponseContentType from saved headers file", async () => {
  const headers = await Deno.readTextFile(new URL("multipart-response.headers", FIX));
  assertEquals(
    readResponseContentType(headers),
    "multipart/form-data; boundary=TestBoundaryStep82A5",
  );
});

Deno.test("boundaryFromBodyStart reads delimiter line, not inner Content-Type text", async () => {
  const body = await readFixture("multipart-body.bin");
  assertEquals(boundaryFromBodyStart(body), "TestBoundaryStep82A5");
});

Deno.test("multipart extract uses header boundary", async () => {
  const body = await readFixture("multipart-body.bin");
  const out = await Deno.makeTempDir({ prefix: "step82a5-mp-" });
  const result = await extractArchive(body, out, {
    contentType: "multipart/form-data; boundary=TestBoundaryStep82A5",
  });
  assertEquals(result.format, "multipart");
  assertEquals(result.files_written, 2);
  assert(result.paths_listed.includes("source/supabase/functions/demo/index.ts"));
});

Deno.test("multipart extract uses body delimiter when Content-Type missing", async () => {
  const body = await readFixture("multipart-body.bin");
  const out = await Deno.makeTempDir({ prefix: "step82a5-mp2-" });
  const boundary = resolveMultipartBoundary(body);
  assertEquals(boundary, "TestBoundaryStep82A5");
  const result = await extractArchive(body, out, {});
  assertEquals(result.format, "multipart");
  assertEquals(result.files_written, 2);
});

Deno.test("zip extract", async () => {
  const body = await readFixture("sample.zip");
  assertEquals(detectFormat(body, "application/zip"), "zip");
  const out = await Deno.makeTempDir({ prefix: "step82a5-zip-" });
  const result = await extractArchive(body, out, { contentType: "application/zip" });
  assertEquals(result.format, "zip");
  assertEquals(result.files_written, 1);
});

Deno.test("gzip/tar extract", async () => {
  const body = await readFixture("sample.tar.gz");
  assertEquals(detectFormat(body, "application/gzip"), "gzip");
  const out = await Deno.makeTempDir({ prefix: "step82a5-gz-" });
  const result = await extractArchive(body, out, { contentType: "application/gzip" });
  assertEquals(result.format, "gzip");
  assertEquals(result.files_written, 1);
});

Deno.test("octet-stream zip detected by magic bytes", async () => {
  const body = await readFixture("octet-stream.zip.bin");
  assertEquals(detectFormat(body, "application/octet-stream"), "zip");
});

Deno.test("json API error is not passed to archive extractor", async () => {
  const body = await readFixture("json-error.json");
  const out = await Deno.makeTempDir({ prefix: "step82a5-json-" });
  const result = await extractArchive(body, out, { contentType: "application/json" });
  assertEquals(result.format, "json_error");
  assertEquals(result.error?.code, "unauthorized");
  assertEquals(result.files_written, 0);
});

Deno.test("malformed archive fails closed", async () => {
  const body = await readFixture("malformed.bin");
  const out = await Deno.makeTempDir({ prefix: "step82a5-bad-" });
  await assertRejects(() => extractArchive(body, out, {}), Error);
});

Deno.test("reject traversal paths", () => {
  assertEquals(isSafeRelative("../etc/passwd"), false);
  assertEquals(isSafeRelative("source/../../escape.ts"), false);
  assertEquals(isSafeRelative("source/ok.ts"), true);
});

Deno.test("reject multipart traversal path", async () => {
  const b = "BadBoundary";
  const evil = `--${b}\r\nContent-Disposition: form-data; name="file"; filename="../../evil.ts"\r\n\r\nx\r\n--${b}--\r\n`;
  const out = await Deno.makeTempDir({ prefix: "step82a5-trav-" });
  await assertRejects(
    () => extractArchive(new TextEncoder().encode(evil), out, { contentType: `multipart/form-data; boundary=${b}` }),
    Error,
    "REJECT archive path",
  );
});

Deno.test("inspect-only lists paths without writing files", async () => {
  const body = await readFixture("multipart-body.bin");
  const out = await Deno.makeTempDir({ prefix: "step82a5-inspect-" });
  const result = await extractArchive(body, out, {
    contentType: "multipart/form-data; boundary=TestBoundaryStep82A5",
    inspectOnly: true,
  });
  assertEquals(result.files_written, 0);
  assertEquals(result.paths_listed.length, 2);
  let count = 0;
  for await (const _ of Deno.readDir(out)) count++;
  assertEquals(count, 0);
});

Deno.test("real downloaded finalize response is multipart delimiter format", async () => {
  const path = "/Users/admin/admin-new/.audit-step82a5-2026-08-19/archives/finalize-trip-and-capture-body-multipart.bin";
  let body: Uint8Array;
  try {
    body = await Deno.readFile(path);
  } catch {
    return; // skip if artifact removed
  }
  assertEquals(detectFormat(body), "multipart");
  const boundary = boundaryFromBodyStart(body);
  assert(boundary?.startsWith("WebKitFormBoundary"));
  const out = await Deno.makeTempDir({ prefix: "step82a5-real-" });
  const result = await extractArchive(body, out, { inspectOnly: true });
  assertEquals(result.format, "multipart");
  assert(result.paths_listed.length > 10);
});
