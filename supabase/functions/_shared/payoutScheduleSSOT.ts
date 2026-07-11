/** Next weekly payout calendar date in the configured timezone (default Europe/London). */

const WEEKDAY_TO_JS: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

export function nextWeeklyPayoutDateIso(args?: {
  weeklyPayoutDay?: string | null;
  timeZone?: string | null;
  now?: Date;
}): string {
  const tz = String(args?.timeZone ?? "Europe/London").trim() || "Europe/London";
  const targetDow = WEEKDAY_TO_JS[String(args?.weeklyPayoutDay ?? "monday").toLowerCase()] ?? 1;
  const now = args?.now ?? new Date();
  const local = new Date(now.toLocaleString("en-US", { timeZone: tz }));
  const day = local.getDay();
  const daysUntil = (targetDow - day + 7) % 7 || 7;
  local.setDate(local.getDate() + daysUntil);
  local.setHours(0, 0, 0, 0);
  return local.toISOString();
}
