import {
  computeNavigationTargetChanged,
  computeRequiresDriverApproval,
} from "./tripModificationApproval.ts";

Deno.test("computeRequiresDriverApproval always false (no Driver approval gate)", () => {
  const requires = computeRequiresDriverApproval({
    changeType: "change_dropoff",
    beforeStops: [
      { type: "pickup", stop_index: 0, address: "A", lat: 52, lng: -0.7, status: "completed" },
      { type: "dropoff", stop_index: 1, address: "B", lat: 52.1, lng: -0.8, status: "pending" },
    ],
    afterStops: [
      { type: "pickup", stop_index: 0, address: "A", lat: 52, lng: -0.7, status: "completed" },
      { type: "dropoff", stop_index: 1, address: "C", lat: 52.2, lng: -0.9, status: "pending" },
    ],
    tripStatus: "in_progress",
    fareDeltaPence: 5000,
    beforeDistanceMeters: 1000,
    afterDistanceMeters: 8000,
    beforeDurationSeconds: 300,
    afterDurationSeconds: 1200,
  });
  if (requires !== false) {
    throw new Error(`expected false, got ${requires}`);
  }
});

Deno.test("computeNavigationTargetChanged detects dropoff identity change", () => {
  const changed = computeNavigationTargetChanged({
    changeType: "change_dropoff",
    beforeStops: [
      { type: "pickup", stop_index: 0, status: "completed" },
      { type: "dropoff", stop_index: 1, address: "B", lat: 52.1, lng: -0.8, status: "pending" },
    ],
    afterStops: [
      { type: "pickup", stop_index: 0, status: "completed" },
      { type: "dropoff", stop_index: 1, address: "C", lat: 52.2, lng: -0.9, status: "pending" },
    ],
    tripStatus: "in_progress",
  });
  if (!changed) throw new Error("expected navigation target changed");
});
