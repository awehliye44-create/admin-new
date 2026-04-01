/**
 * ONECAB Telemetry SDK — Core
 * ============================
 * Production-grade, framework-agnostic telemetry client for ALL ONECAB surfaces.
 * One shared abstraction used by: Customer App, Driver App, Admin Panel,
 * Guest Booking Web, Corporate Booking Web.
 *
 * Sends batched performance events to:  POST /functions/v1/ingest-telemetry
 */

// ── Types ─────────────────────────────────────────────────────────────

export type AppName =
  | 'customer_app'
  | 'driver_app'
  | 'admin_panel'
  | 'guest_web'
  | 'corporate_web';

export type MetricName =
  | 'screen_load_time'
  | 'api_latency'
  | 'transaction_time'
  | 'ttfb'
  | 'render_time'
  | 'interaction_delay'
  | 'network_request_time';

export type Platform = 'ios' | 'android' | 'web';

export interface TelemetryEvent {
  app_name: AppName;
  screen_name: string;
  metric_name: MetricName;
  metric_value: number;
  unit: string;
  platform: Platform;
  app_version?: string;
  device_model?: string;
  os_version?: string;
  session_id: string;
  user_id?: string;
  metadata?: Record<string, unknown>;
}

export interface OnecabTelemetryConfig {
  /** Supabase project URL */
  supabaseUrl: string;
  /** Supabase anon/publishable key */
  supabaseAnonKey: string;
  /** Which surface is sending */
  appName: AppName;
  /** Runtime platform */
  platform: Platform;
  /** Semantic version, e.g. '2.3.1' */
  appVersion?: string;
  /** Device model for mobile, e.g. 'iPhone 15 Pro' */
  deviceModel?: string;
  /** OS version, e.g. 'iOS 17.4' or 'Android 14' */
  osVersion?: string;
  /** Batch size before auto-flush (default 10) */
  batchSize?: number;
  /** Flush interval in ms (default 10_000) */
  flushIntervalMs?: number;
  /** Override noise-filter thresholds (ms) */
  thresholds?: Partial<Record<MetricName, number>>;
  /** Max accepted value to prevent background-tab pollution (default 30_000) */
  maxValueMs?: number;
  /** Disable sending (useful for dev/test) */
  disabled?: boolean;
}

// ── Defaults ──────────────────────────────────────────────────────────

const DEFAULT_THRESHOLDS: Partial<Record<MetricName, number>> = {
  screen_load_time: 500,   // only report loads >500ms
  api_latency: 300,        // only report slow APIs
  render_time: 200,        // only report slow renders
  ttfb: 400,               // only report slow TTFB
  network_request_time: 500,
};

const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_FLUSH_MS = 10_000;
const DEFAULT_MAX_VALUE = 30_000;

// ── Helpers ───────────────────────────────────────────────────────────

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function generateSessionId(appName: string): string {
  return `${appName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Client ────────────────────────────────────────────────────────────

export class OnecabTelemetry {
  private readonly endpoint: string;
  private readonly sessionId: string;
  private readonly thresholds: Partial<Record<MetricName, number>>;
  private readonly maxValue: number;
  private readonly batchSize: number;
  private readonly flushMs: number;

  private buffer: TelemetryEvent[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly config: OnecabTelemetryConfig) {
    this.endpoint = `${config.supabaseUrl}/functions/v1/ingest-telemetry`;
    this.sessionId = generateSessionId(config.appName);
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...config.thresholds };
    this.maxValue = config.maxValueMs ?? DEFAULT_MAX_VALUE;
    this.batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
    this.flushMs = config.flushIntervalMs ?? DEFAULT_FLUSH_MS;
  }

  // ── Core tracking ─────────────────────────────────────────────────

  /**
   * trackScreenLoad — record screen/page load time.
   */
  trackScreenLoad(screenName: string, durationMs: number, meta?: Record<string, unknown>) {
    this.enqueue(screenName, 'screen_load_time', durationMs, meta);
  }

  /**
   * trackApiLatency — record an API call's round-trip time.
   */
  trackApiLatency(screenName: string, durationMs: number, operation?: string) {
    this.enqueue(screenName, 'api_latency', durationMs, operation ? { operation } : undefined);
  }

  /**
   * trackFlowStep — record a user-facing flow step duration
   * (booking, payment, checkout, payout, etc.).
   */
  trackFlowStep(screenName: string, durationMs: number, step: string) {
    this.enqueue(screenName, 'transaction_time', durationMs, { step });
  }

  /**
   * trackError — record an error occurrence with duration context.
   */
  trackError(screenName: string, durationMs: number, errorCode: string, message?: string) {
    this.enqueue(screenName, 'interaction_delay', durationMs, {
      error: true,
      error_code: errorCode,
      message: message?.slice(0, 200),
    });
  }

  /**
   * trackInteraction — record a UI interaction delay.
   */
  trackInteraction(screenName: string, durationMs: number, action: string) {
    this.enqueue(screenName, 'interaction_delay', durationMs, { action });
  }

  // ── Timer helpers ─────────────────────────────────────────────────

  /**
   * startTimer — returns { stop() } that records elapsed time.
   */
  startTimer(screenName: string, metric: MetricName, meta?: Record<string, unknown>) {
    const start = now();
    return {
      stop: () => {
        this.enqueue(screenName, metric, now() - start, meta);
      },
    };
  }

  /**
   * startScreenTimer — convenience for screen load measurement.
   */
  startScreenTimer(screenName: string) {
    return this.startTimer(screenName, 'screen_load_time');
  }

  /**
   * startApiTimer — convenience for API latency measurement.
   */
  startApiTimer(screenName: string, operation?: string) {
    return this.startTimer(screenName, 'api_latency', operation ? { operation } : undefined);
  }

  /**
   * startFlowTimer — convenience for flow step measurement.
   */
  startFlowTimer(screenName: string, step: string) {
    return this.startTimer(screenName, 'transaction_time', { step });
  }

  // ── Flush ─────────────────────────────────────────────────────────

  /** Force flush all buffered events. Safe to call anytime. */
  async flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return;

    const batch = this.buffer.splice(0);
    try {
      await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: this.config.supabaseAnonKey,
        },
        body: JSON.stringify(batch),
      });
    } catch {
      // Best-effort — never block the app
    }
  }

  /** Session ID for this client instance. */
  getSessionId(): string {
    return this.sessionId;
  }

  // ── Internal ──────────────────────────────────────────────────────

  private enqueue(
    screenName: string,
    metric: MetricName,
    value: number,
    metadata?: Record<string, unknown>,
  ) {
    if (this.config.disabled) return;

    const rounded = Math.round(value);

    // Noise filter
    const threshold = this.thresholds[metric];
    if (threshold !== undefined && rounded < threshold) return;

    // Outlier filter (background tabs, stale timers)
    if (rounded > this.maxValue && metric !== 'transaction_time') return;

    this.buffer.push({
      app_name: this.config.appName,
      screen_name: screenName,
      metric_name: metric,
      metric_value: rounded,
      unit: 'ms',
      platform: this.config.platform,
      app_version: this.config.appVersion,
      device_model: this.config.deviceModel,
      os_version: this.config.osVersion,
      session_id: this.sessionId,
      metadata,
    });

    if (this.buffer.length >= this.batchSize) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.flushMs);
    }
  }
}
