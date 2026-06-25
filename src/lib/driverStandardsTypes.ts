export type DriverStandardsStatus =
  | "excellent"
  | "good"
  | "needs_improvement"
  | "at_risk";

export type DriverStandardsWarningCode =
  | "heading_to_pickup"
  | "reduce_cancellations"
  | "improve_arrival";

export interface DriverStandardsWarningBanner {
  code: DriverStandardsWarningCode;
  title: string;
  message: string;
}

export interface DriverStandardsFeedbackTag {
  tag: string;
  count: number;
}

export interface DriverStandardsTrendPoint {
  date: string;
  acceptance_rate: number | null;
  pickup_reliability_rate: number | null;
  on_time_arrival_rate: number | null;
  cancellation_rate: number | null;
}

export interface DriverStandardsActivity {
  at: string;
  kind: "trip_completed" | "new_rating" | "trip_cancelled";
  label: string;
}

export interface DriverStandardsData {
  driver_id: string;
  period_days: number;
  period_start: string;
  period_end: string;
  average_rating: number | null;
  rating_count: number;
  rating_window_size: number;
  rating_breakdown: Record<string, number>;
  acceptance_rate: number | null;
  accepted_offers: number;
  total_offers: number;
  cancellation_rate: number | null;
  driver_cancelled_trips: number;
  accepted_trips: number;
  completion_rate: number | null;
  completed_trips: number;
  pickup_reliability_rate: number | null;
  pickup_reliable_trips: number;
  on_time_arrival_rate: number | null;
  on_time_arrivals: number;
  customer_feedback_tags: DriverStandardsFeedbackTag[];
  performance_trend: DriverStandardsTrendPoint[];
  recent_activity: DriverStandardsActivity[];
  driver_status: DriverStandardsStatus;
  warning_banner: DriverStandardsWarningBanner | null;
  last_updated_at: string;
  metrics_refresh_note: string;
  min_offers_for_rates: number;
  min_accepted_trips_for_rates: number;
}

export const DRIVER_STANDARDS_ROUTE = "/driver/star-rating";

export const DRIVER_STANDARDS_COPY = {
  screenTitle: "Driver Standards",
  subtitle: "Your performance for the last 30 days",
  metricsRefreshNote: "Metrics update every 24 hours",
  notEnoughData: "Not enough data yet",
  basedOnRatings: (count: number, window: number) =>
    `Based on last ${Math.min(count, window)} ratings`,
  helpTitle: "About Driver Standards",
  helpBody:
    "Your Driver Standards score combines customer ratings, trip reliability, and acceptance behaviour over the selected period. " +
    "Metrics refresh once every 24 hours and require enough trips before percentages are shown.",
  viewStandards: "View Driver Standards",
  viewPerformance: "View Driver Standards",
  newDriverNote: "New drivers start at 5.00 until customer ratings are received",
  breakdownTitle: "Ratings breakdown",
  negativeTitle: "What customers didn't like",
  positiveTitle: "What customers liked",
  complimentsTitle: "Compliments",
  likedFallbackNote: "Customers haven't highlighted what they liked yet.",
  dislikedFallbackNote: "No issues reported yet.",
  complimentsFallbackNote: "No compliments yet.",
  windowNote: (windowSize: number) =>
    `Based on your last ${windowSize} ratings. Metrics refresh every 24 hours.`,
  statusLabels: {
    excellent: "Excellent",
    good: "Good",
    needs_improvement: "Needs Improvement",
    at_risk: "At Risk",
  } as Record<DriverStandardsStatus, string>,
  statusMessages: {
    excellent: "You're doing great! Keep it up to unlock more opportunities.",
    good: "Solid performance — a few improvements can move you to Excellent.",
    needs_improvement: "Focus on acceptance, pickup reliability, and completing trips.",
    at_risk: "Your performance needs attention. Review the guidance below.",
  } as Record<DriverStandardsStatus, string>,
} as const;

export function formatRate(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return DRIVER_STANDARDS_COPY.notEnoughData;
  return `${value.toFixed(value % 1 === 0 ? 0 : 1)}%`;
}

export function formatRating(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "—";
  return value.toFixed(2);
}

export function metricQualityLabel(
  metric: "acceptance" | "cancellation" | "completion" | "pickup" | "on_time" | "rating",
  value: number | null,
): string | null {
  if (value == null) return null;
  switch (metric) {
    case "cancellation":
      if (value <= 7) return "Excellent";
      if (value <= 12) return "Good";
      if (value <= 15) return "Fair";
      return "Needs work";
    case "rating":
      if (value >= 4.8) return "Excellent";
      if (value >= 4.5) return "Very Good";
      if (value >= 4.0) return "Good";
      return "Needs work";
    default:
      if (value >= 95) return "Excellent";
      if (value >= 90) return "Very Good";
      if (value >= 80) return "Good";
      return "Needs work";
  }
}

export function parseDriverStandards(data: unknown): DriverStandardsData | null {
  if (!data || typeof data !== "object") return null;
  const row = data as Record<string, unknown>;
  return {
    driver_id: String(row.driver_id ?? ""),
    period_days: Number(row.period_days ?? 30),
    period_start: String(row.period_start ?? ""),
    period_end: String(row.period_end ?? ""),
    average_rating: row.average_rating == null ? null : Number(row.average_rating),
    rating_count: Number(row.rating_count ?? 0),
    rating_window_size: Number(row.rating_window_size ?? 50),
    rating_breakdown: (row.rating_breakdown as Record<string, number>) ?? {},
    acceptance_rate: row.acceptance_rate == null ? null : Number(row.acceptance_rate),
    accepted_offers: Number(row.accepted_offers ?? 0),
    total_offers: Number(row.total_offers ?? 0),
    cancellation_rate: row.cancellation_rate == null ? null : Number(row.cancellation_rate),
    driver_cancelled_trips: Number(row.driver_cancelled_trips ?? 0),
    accepted_trips: Number(row.accepted_trips ?? 0),
    completion_rate: row.completion_rate == null ? null : Number(row.completion_rate),
    completed_trips: Number(row.completed_trips ?? 0),
    pickup_reliability_rate:
      row.pickup_reliability_rate == null ? null : Number(row.pickup_reliability_rate),
    pickup_reliable_trips: Number(row.pickup_reliable_trips ?? 0),
    on_time_arrival_rate:
      row.on_time_arrival_rate == null ? null : Number(row.on_time_arrival_rate),
    on_time_arrivals: Number(row.on_time_arrivals ?? 0),
    customer_feedback_tags: Array.isArray(row.customer_feedback_tags)
      ? (row.customer_feedback_tags as DriverStandardsFeedbackTag[])
      : [],
    performance_trend: Array.isArray(row.performance_trend)
      ? (row.performance_trend as DriverStandardsTrendPoint[])
      : [],
    recent_activity: Array.isArray(row.recent_activity)
      ? (row.recent_activity as DriverStandardsActivity[])
      : [],
    driver_status: (row.driver_status as DriverStandardsStatus) ?? "needs_improvement",
    warning_banner: (row.warning_banner as DriverStandardsWarningBanner | null) ?? null,
    last_updated_at: String(row.last_updated_at ?? ""),
    metrics_refresh_note: String(row.metrics_refresh_note ?? DRIVER_STANDARDS_COPY.metricsRefreshNote),
    min_offers_for_rates: Number(row.min_offers_for_rates ?? 5),
    min_accepted_trips_for_rates: Number(row.min_accepted_trips_for_rates ?? 5),
  };
}
