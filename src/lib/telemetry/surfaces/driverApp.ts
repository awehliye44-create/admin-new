/**
 * ONECAB Telemetry — Driver App (React Native) Integration
 * =========================================================
 * Drop-in integration for the Driver mobile app.
 *
 * SETUP:
 * 1. Copy core.ts and react.ts into your React Native project
 * 2. Create this file as your singleton
 * 3. Wire flush on AppState change (see customerApp.ts for pattern)
 *
 * SCREENS TO INSTRUMENT:
 *   - Home / Dashboard     → useScreenLoad(driverTelemetry, 'Home')
 *   - AcceptTripScreen     → useScreenLoad + flow('accept_trip')
 *   - TripDetailsScreen    → useScreenLoad + apiTimer('fetch_trip')
 *   - NavigationScreen     → useScreenLoad
 *   - EarningsScreen       → useScreenLoad + apiTimer('fetch_earnings')
 *   - PayoutScreen         → useScreenLoad + flow('request_payout')
 *   - SettlementScreen     → useScreenLoad + apiTimer('fetch_settlements')
 *   - RatingsScreen        → useScreenLoad
 *
 * TRIP LIFECYCLE TRACKING:
 *   // Track each state transition
 *   const t = driverTelemetry.startFlowTimer('TripFlow', 'accept_to_arrived');
 *   // ...driver navigates to pickup...
 *   t.stop(); // records elapsed time
 *
 *   const t2 = driverTelemetry.startFlowTimer('TripFlow', 'pickup_to_complete');
 *   // ...trip in progress...
 *   t2.stop();
 *
 * EXAMPLE:
 *   import { driverTelemetry } from '../telemetry/driverApp';
 *   import { useScreenLoad, useApiTimer } from '../telemetry/react';
 *
 *   function EarningsScreen() {
 *     useScreenLoad(driverTelemetry, 'EarningsScreen');
 *     const api = useApiTimer(driverTelemetry, 'EarningsScreen');
 *
 *     useEffect(() => {
 *       const t = api('fetch_earnings');
 *       fetchEarnings().then(() => t.stop());
 *     }, []);
 *   }
 */

import { OnecabTelemetry } from '../core';

export const driverTelemetry = new OnecabTelemetry({
  supabaseUrl: 'https://thazislrdkjpvvghtvzo.supabase.co',
  supabaseAnonKey: '__DRIVER_APP_ANON_KEY__',
  appName: 'driver_app',
  platform: 'android', // Override per-device: 'ios' | 'android'
  appVersion: '1.0.0',
  // React Native teams: set deviceModel and osVersion at runtime
  // Higher max for trip lifecycle tracking
  maxValueMs: 600_000, // 10 minutes for trip transitions
  thresholds: {
    screen_load_time: 500,
    api_latency: 300,
    render_time: 200,
    transaction_time: 0, // always track trip flow steps
  },
});
