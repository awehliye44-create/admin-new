import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assertEquals, assertExists } from "https://deno.land/std@0.224.0/assert/mod.ts";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY")!;

const BASE_URL = `${SUPABASE_URL}/functions/v1/cancel-trip`;

async function callCancelTrip(body: Record<string, unknown>) {
  const res = await fetch(BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { status: res.status, data };
}

Deno.test("cancel-trip: rejects missing fields", async () => {
  const { status, data } = await callCancelTrip({ trip_id: "fake" });
  assertEquals(status, 400);
  assertExists(data.error);
});

Deno.test("cancel-trip: rejects non-existent trip", async () => {
  const { status, data } = await callCancelTrip({
    trip_id: "00000000-0000-0000-0000-000000000000",
    cancelled_by: "rider",
    cancelled_by_id: "00000000-0000-0000-0000-000000000001",
  });
  assertEquals(status, 404);
  assertExists(data.error);
});

Deno.test("cancel-trip: rejects invalid JSON", async () => {
  const res = await fetch(BASE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: "not json",
  });
  const data = await res.json();
  assertEquals(res.status, 400);
  assertEquals(data.error, "Invalid JSON");
});
