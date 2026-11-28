/** Offline test/audit-only helpers; not part of Edge uploads. */
/**
 * FR capture-composition identity SSOT (display/classification only).
 *
 * When a payment session carries typed capture composition, expected provider
 * capture is the sum of planned components — never trip fare alone:
 *   trip_fare + tip + receivable (+ any explicit planned capture component)
 *
 * MK-260925-003: 704 + 0 + 36 = 740 → variance 0 → settlement identity balanced.
 *
 * Fold/buffer stay OFF: buffer is not part of capture target unless explicitly
 * persisted as a capture component (normally 0).
 *
 * No money mutation — classification only.
 */

import {
  readCaptureCompositionComponents,
  type CaptureCompositionComponents,
} from "../../../functions/_shared/captureCompositionLocalApplySSOT.ts";
import { FrCaptureCompositionIdentity, evaluateFrCaptureCompositionIdentityClosed } from "../../../functions/_shared/frCaptureCompositionIdentitySSOT.ts";


/**
 * Prefer composition identity when receivable (or multi-component target)
 * is present. Fail closed when composition is required but unreadable.
 * Returns absent for fare-only / no composition (legacy allocation path).
 */
export function evaluateFrCaptureCompositionIdentity(args: {
  session: {
    trip_fare_component_pence?: number | null;
    tip_component_pence?: number | null;
    receivable_component_pence?: number | null;
    buffer_pence?: number | null;
    provider_capture_target_pence?: number | null;
    metadata?: Record<string, unknown> | null;
    captured_amount_pence?: number | null;
    purpose?: string | null;
  } | null | undefined;
  actual_captured_pence?: number | null;
}): FrCaptureCompositionIdentity | null {
  const result = evaluateFrCaptureCompositionIdentityClosed(args);
  if (result.kind === "ok") return result.identity;
  return null;
}

export * from "../../../functions/_shared/frCaptureCompositionIdentitySSOT.ts";
