/**
 * ONECAB Platform Telemetry Client
 * ================================
 * Portable, framework-agnostic telemetry client for all ONECAB surfaces.
 * Drop this file into any app (React, React Native, vanilla JS) to send
 * performance metrics to the central ingest-telemetry Edge Function.
 *
 * Supported app names:
 *   'customer_app' | 'driver_app' | 'guest_web' | 'admin_panel' | 'corporate_web'
 *
 * Supported metrics:
 *   'screen_load_time' | 'api_latency' | 'transaction_time' | 'ttfb' |
 *   'render_time' | 'interaction_delay' | 'network_request_time'
 */

export type AppName = 'customer_app' | 'driver_app' | 'guest_web' | 'admin_panel' | 'corporate_web';
export type MetricName = 'screen_load_time' | 'api_latency' | 'transaction_time' | 'ttfb' | 'render_time' | 'interaction_delay' | 'network_request_time';
export type Platform = 'ios' | 'android' | 'web';

export interface TelemetryEvent {
  app_name: AppName;
  screen_name: string;
  metric_name: MetricName;
  metric_value: number;
  unit?: string;
  platform?: Platform;
  app_version?: string;
  device_model?: string;
  os_version?: string;
  session_id?: string;
  user_id?: string;
  metadata?: Record<string, unknown>;
}

export interface TelemetryClientConfig {
  /** Supabase project URL, e.g. https://xxxx.supabase.co */
  supabaseUrl: string;
  /** Supabase anon/publishable key */
  supabaseAnonKey: string;
  /** Which app is sending telemetry */
  appName: AppName;
  /** Platform: ios, android, or web */
  platform: Platform;
  /** App version string, e.g. '2.1.0' */
  appVersion?: string;
  /** Device model for mobile, e.g. 'iPhone 15 Pro' */
  deviceModel?: string;
  /** OS version, e.g. 'iOS 17.4' */
  osVersion?: string;
  /** Max buffer size before auto-flush (default: 10) */
  batchSize?: number;
  /** Flush interval in ms (default: 10000) */
  flushIntervalMs?: number;
  /** Client-side thresholds — events below these are dropped to save bandwidth */
  thresholds?: Partial<Record<MetricName, number>>;
  /** Max metric_value to accept (prevents background-tab pollution, default: 30000) */
  maxValueMs?: number;
}

const DEFAULT_THRESHOLDS: Partial<Record<MetricName, number>> = {
  screen_load_time: 500,
  api_latency: 300,
  render_time: 200,
};

export class TelemetryClient {
  private config: Required<Pick<TelemetryClientConfig, 'supabaseUrl' | 'supabaseAnonKey' | 'appName' | 'platform'>> & TelemetryClientConfig;
  private buffer: TelemetryEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private sessionId: string;
  private endpoint: string;
  private thresholds: Partial<Record<MetricName, number>>;
  private maxValue: number;

  constructor(config: TelemetryClientConfig) {
    this.config = config;
    this.endpoint = `${config.supabaseUrl}/functions/v1/ingest-telemetry`;
    this.sessionId = `${config.appName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...config.thresholds };
    this.maxValue = config.maxValueMs ?? 30000;
  }

  /** Enqueue a telemetry event (batched and flushed automatically) */
  track(screenName: string, metricName: MetricName, metricValue: number, metadata?: Record<string, unknown>) {
    // Drop fast/healthy events
    const threshold = this.thresholds[metricName];
    if (threshold !== undefined && metricValue < threshold) return;

    // Drop outliers (backgrounded tabs, stale timers)
    if (metricValue > this.maxValue) return;

    this.buffer.push({
      app_name: this.config.appName,
      screen_name: screenName,
      metric_name: metricName,
      metric_value: Math.round(metricValue),
      platform: this.config.platform,
      app_version: this.config.appVersion,
      device_model: this.config.deviceModel,
      os_version: this.config.osVersion,
      session_id: this.sessionId,
      metadata,
    });

    const batchSize = this.config.batchSize ?? 10;
    if (this.buffer.length >= batchSize) {
      this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), this.config.flushIntervalMs ?? 10000);
    }
  }

  /** Create a latency tracker — call start(), it returns stop() */
  startTimer(screenName: string, metricName: MetricName, metadata?: Record<string, unknown>) {
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    return {
      stop: () => {
        const duration = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start;
        this.track(screenName, metricName, duration, metadata);
      },
    };
  }

  /** Force-flush the buffer (call on app background / page hide) */
  async flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.buffer.length === 0) return;

    const batch = this.buffer.splice(0, this.buffer.length);
    try {
      await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'apikey': this.config.supabaseAnonKey,
        },
        body: JSON.stringify(batch),
      });
    } catch {
      // Best-effort — silently drop on failure
    }
  }

  /** Get the current session ID */
  getSessionId() {
    return this.sessionId;
  }
}
