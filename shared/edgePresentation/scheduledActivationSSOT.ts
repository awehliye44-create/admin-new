/** Admin presentation-only helpers; not part of Edge uploads. */
import { ScheduledActivationConfig } from "../../supabase/functions/_shared/scheduledActivationSSOT.ts";


export const SCHEDULED_ACTIVATION_MAXIMA: ScheduledActivationConfig = {
  longTripThresholdMinutes: 24 * 60,
  localActivationMinutesBeforePickup: 24 * 60,
  longActivationMinutesBeforePickup: 24 * 60,
  urgentFallbackMinutesBeforePickup: 24 * 60,
};
