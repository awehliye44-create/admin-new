/**
 * Fire-and-forget Live Trip projection publish.
 * Never blocks trip mutations / payments — presentation delivery only.
 */
import { scheduleEdgeBackground } from "./scheduleEdgeBackground.ts";

declare const EdgeRuntime:
  | { waitUntil?: (promise: Promise<unknown>) => void }
  | undefined;

/**
 * Best-effort invoke of publish-customer-live-trip after lifecycle changes.
 * Failures are logged only — callers must not await for correctness of booking.
 */
export function publishCustomerLiveTripBestEffort(
  tripId: string,
  opts?: { priority?: "lifecycle" | "assignment" | "rematch" | "arrival" | "terminal" | "eta" },
): void {
  const id = tripId.trim();
  if (!id) return;

  scheduleEdgeBackground(async () => {
    const supabaseUrl = (Deno.env.get("SUPABASE_URL") ?? "").replace(/\/$/, "");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!supabaseUrl || !serviceRoleKey) {
      console.warn("[publishCustomerLiveTripBestEffort] missing env", {
        trip_id: id,
      });
      return;
    }
    const response = await fetch(
      `${supabaseUrl}/functions/v1/publish-customer-live-trip`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${serviceRoleKey}`,
          apikey: serviceRoleKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          trip_id: id,
          priority: opts?.priority ?? "lifecycle",
        }),
      },
    );
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      console.warn("[publishCustomerLiveTripBestEffort] publish failed", {
        trip_id: id,
        http_status: response.status,
        message: text.slice(0, 200),
      });
    }
  }, `publish_live_trip:${id}`);
}
