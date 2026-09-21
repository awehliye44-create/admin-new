/**
 * Lock: cancel-trip must notify assigned Driver so BG/killed Trip Cancelled works.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname ?? __dirname, "../..");

function read(rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}

Deno.test("cancel-trip notifies assigned driver via notifyDriverTripStopped", () => {
  const src = read("supabase/functions/cancel-trip/index.ts");
  if (!src.includes('notifyDriverTripStopped')) {
    throw new Error("cancel-trip missing notifyDriverTripStopped import/call");
  }
  if (!src.includes("driver trip_cancelled push failed")) {
    throw new Error("cancel-trip missing driver cancel push fire-and-forget");
  }
});

Deno.test("send-driver-notification makes cancel-flavored RIDE_STOP audible", () => {
  const src = read("supabase/functions/send-driver-notification/index.ts");
  if (!src.includes("isCancelRideStop")) {
    throw new Error("missing isCancelRideStop branch");
  }
  if (!src.includes('sound: "trip_cancelled"') && !src.includes("sound: 'trip_cancelled'")) {
    throw new Error("Android cancel stop missing trip_cancelled sound");
  }
  if (!src.includes("trip_cancelled.wav")) {
    throw new Error("iOS cancel stop missing trip_cancelled.wav");
  }
});
