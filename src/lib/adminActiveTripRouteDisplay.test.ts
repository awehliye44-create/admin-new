import { describe, expect, it } from "vitest";
import {
  formatAdminActiveTripRouteLines,
  resolveAdminActiveTripRouteModel,
  resolveAdminIntermediateStops,
} from "@/lib/adminActiveTripRouteDisplay";

describe("adminActiveTripRouteDisplay", () => {
  it("zero intermediates → single pickup → dropoff", () => {
    const model = resolveAdminActiveTripRouteModel({
      pickup_address: "Home",
      dropoff_address: "Airport",
      trip_stops: [
        { id: "p", stop_index: 0, type: "pickup", address: "Home", status: "completed" },
        { id: "d", stop_index: 1, type: "dropoff", address: "Airport", status: "pending" },
      ],
      total_stops: 2,
      current_stop_index: 1,
    });
    expect(model.isMultiStop).toBe(false);
    expect(model.intermediateCount).toBe(0);
    expect(formatAdminActiveTripRouteLines(model)).toEqual(["Home", "Airport"]);
  });

  it("preserves ordered intermediates from trip_stops (never flatten)", () => {
    const model = resolveAdminActiveTripRouteModel({
      pickup_address: "Pickup",
      dropoff_address: "Final",
      current_stop_index: 2,
      total_stops: 4,
      trip_stops: [
        { id: "p", stop_index: 0, type: "pickup", address: "Pickup", status: "completed" },
        { id: "a", stop_index: 1, type: "stop", address: "Stop A", status: "completed" },
        { id: "b", stop_index: 2, type: "stop", address: "Stop B", status: "current" },
        { id: "d", stop_index: 3, type: "dropoff", address: "Final", status: "pending" },
      ],
    });
    expect(model.isMultiStop).toBe(true);
    expect(model.intermediateCount).toBe(2);
    expect(model.activeLegLabel).toBe("Stop B");
    expect(model.nextDestinationAddress).toBe("Stop B");
    expect(formatAdminActiveTripRouteLines(model)).toEqual([
      "Pickup",
      "Stop A",
      "Stop B",
      "Final",
    ]);
  });

  it("reconstructs vias from trips.stops when trip_stops lack intermediates", () => {
    const vias = resolveAdminIntermediateStops({
      trip_stops: [
        { id: "p", stop_index: 0, type: "pickup", address: "Pickup", status: "pending" },
        { id: "d", stop_index: 1, type: "dropoff", address: "Final", status: "pending" },
      ],
      stops: [
        { address: "Via 1", lat: 1, lng: 2 },
        { address: "Via 2", lat: 3, lng: 4 },
      ],
    });
    expect(vias.map((v) => v.address)).toEqual(["Via 1", "Via 2"]);
  });

  it("active leg becomes final when current_stop_index past intermediates", () => {
    const model = resolveAdminActiveTripRouteModel({
      pickup_address: "Pickup",
      dropoff_address: "Final Destination",
      current_stop_index: 3,
      total_stops: 4,
      trip_stops: [
        { id: "a", stop_index: 1, type: "stop", address: "A", status: "completed" },
        { id: "b", stop_index: 2, type: "stop", address: "B", status: "completed" },
      ],
    });
    expect(model.activeLegLabel).toBe("Final Destination");
    expect(model.isMultiStop).toBe(true);
  });
});
