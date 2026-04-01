/**
 * ONECAB Telemetry — Customer App (React Native) Integration
 * ============================================================
 * Drop-in integration for the Customer mobile app.
 *
 * SETUP:
 * 1. Copy core.ts and react.ts into your React Native project
 * 2. Create this file as your singleton
 * 3. Wire flush on AppState change
 *
 * APP ENTRY (App.tsx):
 *
 *   import { AppState, Platform } from 'react-native';
 *   import { customerTelemetry } from './telemetry/customerApp';
 *   import DeviceInfo from 'react-native-device-info';
 *
 *   // Set device info after import
 *   // (config is set in constructor, override via metadata if needed)
 *
 *   useEffect(() => {
 *     const sub = AppState.addEventListener('change', (state) => {
 *       if (state === 'background') customerTelemetry.flush();
 *     });
 *     return () => sub.remove();
 *   }, []);
 *
 * SCREENS TO INSTRUMENT:
 *   - HomeScreen           → useScreenLoad(customerTelemetry, 'HomeScreen')
 *   - BookingFlow          → useScreenLoad + flow('select_vehicle'), flow('confirm_booking')
 *   - PaymentScreen        → useScreenLoad + flow('payment_submit')
 *   - WalletScreen         → useScreenLoad + apiTimer('fetch_wallet')
 *   - BookingConfirmation  → useScreenLoad
 *   - TripDetailsScreen    → useScreenLoad + apiTimer('fetch_trip')
 *   - RatingsScreen        → useScreenLoad + flow('submit_rating')
 *
 * EXAMPLE:
 *   import { customerTelemetry } from '../telemetry/customerApp';
 *   import { useScreenLoad, useFlowTimer } from '../telemetry/react';
 *
 *   function BookingFlow() {
 *     useScreenLoad(customerTelemetry, 'BookingFlow');
 *     const flow = useFlowTimer(customerTelemetry, 'BookingFlow');
 *
 *     const onConfirm = async () => {
 *       const t = flow('confirm_booking');
 *       await api.confirmBooking(data);
 *       t.stop();
 *     };
 *   }
 */

import { OnecabTelemetry } from '../core';

export const customerTelemetry = new OnecabTelemetry({
  supabaseUrl: 'https://thazislrdkjpvvghtvzo.supabase.co',
  supabaseAnonKey: '__CUSTOMER_APP_ANON_KEY__',
  appName: 'customer_app',
  platform: 'ios', // Override per-device: 'ios' | 'android'
  appVersion: '1.0.0',
  // React Native teams: set deviceModel and osVersion at runtime
});
