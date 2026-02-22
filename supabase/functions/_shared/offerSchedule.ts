/**
 * Server-side helper to check if preset offers are currently allowed
 * based on the offer schedule configuration and service area timezone.
 */

interface OfferScheduleConfig {
  is_enabled: boolean;
  schedule_enabled: boolean;
  schedule_days: number[]; // 1=Mon..7=Sun
  schedule_start_time: string; // "HH:mm"
  schedule_end_time: string; // "HH:mm"
}

interface ScheduleCheckResult {
  offersEnabled: boolean;
  offersAllowedNow: boolean;
  reason?: string;
}

/**
 * Check if offers are allowed right now given config + timezone.
 * 
 * Rules:
 * - If is_enabled == false => offers OFF
 * - If schedule_enabled == false => offers ON (no schedule restriction)
 * - If schedule_enabled == true => check day + time window in service area timezone
 */
export function checkOfferSchedule(
  config: OfferScheduleConfig | null,
  timezone: string
): ScheduleCheckResult {
  // No config or feature disabled
  if (!config || !config.is_enabled) {
    return { offersEnabled: false, offersAllowedNow: false, reason: 'OFFERS_DISABLED' };
  }

  // Schedule not enabled = offers always allowed when feature is on
  if (!config.schedule_enabled) {
    return { offersEnabled: true, offersAllowedNow: true };
  }

  // Get current time in service area timezone
  const now = new Date();
  
  // Get day of week in target timezone (JS: 0=Sun, we need 1=Mon..7=Sun)
  const dayFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
  });
  const weekdayStr = dayFormatter.format(now);
  const dayMap: Record<string, number> = {
    Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
  };
  const currentDay = dayMap[weekdayStr];

  if (!currentDay || !config.schedule_days.includes(currentDay)) {
    return {
      offersEnabled: true,
      offersAllowedNow: false,
      reason: 'OFFERS_OUTSIDE_SCHEDULE',
    };
  }

  // Get current HH:mm in timezone
  const timeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = timeFormatter.formatToParts(now);
  const hour = parts.find(p => p.type === 'hour')?.value || '00';
  const minute = parts.find(p => p.type === 'minute')?.value || '00';
  const currentHHmm = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;

  const start = config.schedule_start_time || '00:00';
  const end = config.schedule_end_time || '23:59';

  // Simple range check (no overnight wrap support for now)
  if (currentHHmm < start || currentHHmm >= end) {
    return {
      offersEnabled: true,
      offersAllowedNow: false,
      reason: 'OFFERS_OUTSIDE_SCHEDULE',
    };
  }

  return { offersEnabled: true, offersAllowedNow: true };
}
