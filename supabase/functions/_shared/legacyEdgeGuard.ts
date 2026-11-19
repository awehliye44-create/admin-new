/**
 * Hard-block legacy / ghost edge functions from production mutation paths.
 */

import { errorResponse } from "./security.ts";

export function legacyEdgeBlockedResponse(
  edgeName: string,
  replacement: string,
): Response {
  console.warn(`[${edgeName}] LEGACY_EDGE_BLOCKED — use ${replacement}`);
  return errorResponse(
    "LEGACY_EDGE_BLOCKED",
    `${edgeName} is retired. Use ${replacement}.`,
    410,
    { replacement, edge: edgeName },
  );
}
