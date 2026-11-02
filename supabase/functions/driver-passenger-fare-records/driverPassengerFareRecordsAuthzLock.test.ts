/**
 * LOCK — driver-passenger-fare-records must authenticate in-function when verify_jwt=false.
 * Run: deno test --allow-read supabase/functions/driver-passenger-fare-records/driverPassengerFareRecordsAuthzLock.test.ts
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { extractDriverBearerToken } from "./authz.ts";

Deno.test("rejects missing / blank / anon / service-role bearer tokens", () => {
  assertEquals(extractDriverBearerToken(null, "anon", "service").ok, false);
  assertEquals(extractDriverBearerToken("", "anon", "service").ok, false);
  assertEquals(extractDriverBearerToken("Bearer ", "anon", "service").ok, false);
  assertEquals(extractDriverBearerToken("Bearer anon", "anon", "service").ok, false);
  assertEquals(extractDriverBearerToken("Bearer service", "anon", "service").ok, false);
  assertEquals(extractDriverBearerToken("Bearer sb_secret_x", "anon", "service").ok, false);
  assertEquals(extractDriverBearerToken("Bearer user.jwt.token", "anon", "service").ok, true);
});

Deno.test("source lock: ownership + no PII / PDF / mutations", async () => {
  const src = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assertEquals(src.includes("auth.getUser()"), true);
  assertEquals(src.includes('.eq("driver_id", driver.id)'), true);
  assertEquals(src.includes("body.driver_id"), true);
  assertEquals(src.includes("pdf_download_authorised: false"), true);
  assertEquals(/passenger_phone|passenger_email/.test(src), false);
  assertEquals(/\.select\([\s\S]*invoice_pdf_url/.test(src), false);
  assertEquals(/signed_url/.test(src), false);
  assertEquals(/\.from\("trips"\)[\s\S]*\.(update|insert|delete)\(/.test(src), false);
  assertEquals(src.includes("extractDriverBearerToken"), true);
});
