/**
 * ONECAB Telemetry — React Native Integration Example
 * =====================================================
 * Copy telemetryClient.ts and react-hooks.ts into your React Native project.
 * Then follow this pattern:
 *
 * 1. Create a singleton client in your app entry:
 *
 *    // src/lib/telemetry.ts
 *    import { TelemetryClient } from './telemetryClient';
 *    import { Platform } from 'react-native';
 *    import DeviceInfo from 'react-native-device-info';
 *
 *    export const telemetry = new TelemetryClient({
 *      supabaseUrl: 'https://thazislrdkjpvvghtvzo.supabase.co',
 *      supabaseAnonKey: '<your-anon-key>',
 *      appName: 'driver_app',  // or 'customer_app'
 *      platform: Platform.OS as 'ios' | 'android',
 *      appVersion: DeviceInfo.getVersion(),
 *      deviceModel: DeviceInfo.getModel(),
 *      osVersion: `${Platform.OS} ${Platform.Version}`,
 *    });
 *
 * 2. Flush on app background (App.tsx):
 *
 *    import { AppState } from 'react-native';
 *    import { telemetry } from './lib/telemetry';
 *
 *    useEffect(() => {
 *      const sub = AppState.addEventListener('change', (state) => {
 *        if (state === 'background') telemetry.flush();
 *      });
 *      return () => sub.remove();
 *    }, []);
 *
 * 3. Track screen loads in every screen:
 *
 *    import { useScreenLoadTelemetry } from './lib/react-hooks';
 *    import { telemetry } from './lib/telemetry';
 *
 *    export function EarningsScreen() {
 *      useScreenLoadTelemetry(telemetry, 'Earnings');
 *      // ... rest of screen
 *    }
 *
 * 4. Track API calls:
 *
 *    import { useApiTimer } from './lib/react-hooks';
 *
 *    const track = useApiTimer(telemetry, 'Earnings');
 *    const timer = track('fetchEarnings');
 *    const data = await api.getEarnings();
 *    timer.stop();  // records latency automatically
 *
 * 5. Track transactions (e.g., trip accept flow):
 *
 *    const timer = telemetry.startTimer('TripOffer', 'transaction_time', { action: 'accept_trip' });
 *    await api.acceptTrip(tripId);
 *    timer.stop();
 *
 * That's it! All data flows to the same ops_alerts detection engine.
 */

export {};
