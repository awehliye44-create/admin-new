/**
 * Vehicle type list ordering SSOT — admin display_order drives Recommended tab.
 * Shared by calculate-fare and resolve-service-area (Deno).
 */

export type VehicleSortRow = {
  displayOrder?: number | null;
  name: string;
};

export function vehicleDisplayOrderValue(displayOrder: number | null | undefined): number {
  return typeof displayOrder === "number" && Number.isFinite(displayOrder) ? displayOrder : 999;
}

export function compareVehicleByDisplayOrder(a: VehicleSortRow, b: VehicleSortRow): number {
  const orderDelta = vehicleDisplayOrderValue(a.displayOrder) - vehicleDisplayOrderValue(b.displayOrder);
  if (orderDelta !== 0) return orderDelta;
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

export function sortVehicleRowsByDisplayOrder<T extends VehicleSortRow>(rows: readonly T[]): T[] {
  return [...rows].sort(compareVehicleByDisplayOrder);
}

export function resolveVehicleDisplayOrder(args: {
  vehicleTypeId: string;
  assignedDisplayOrder?: Map<string, number>;
  vehicleDisplayOrder?: number | null;
}): number {
  const assigned = args.assignedDisplayOrder?.get(args.vehicleTypeId);
  if (typeof assigned === "number" && Number.isFinite(assigned)) return assigned;
  return vehicleDisplayOrderValue(args.vehicleDisplayOrder);
}
