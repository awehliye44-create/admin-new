/**
 * ONECAB Telemetry — Corporate Booking Web Integration
 * =====================================================
 * Drop-in integration for the Corporate Booking Web surface.
 *
 * SETUP:
 * 1. Copy core.ts, react.ts, fetchInterceptor.ts into your project
 * 2. Create this file as your singleton
 *
 * SCREENS TO INSTRUMENT:
 *   - Dashboard           → useScreenLoad
 *   - BookingPage          → useScreenLoad + flow('create_booking')
 *   - ReportsPage          → useScreenLoad + apiTimer('fetch_reports')
 *   - InvoicePage          → useScreenLoad + flow('download_invoice')
 *   - PaymentPage          → useScreenLoad + flow('payment_submit')
 *   - BookingConfirmation  → useScreenLoad
 *
 * EXAMPLE:
 *   import { corporateTelemetry } from './telemetry/corporateWeb';
 *   import { useScreenLoad, useFlowTimer } from './telemetry/react';
 *
 *   function BookingPage() {
 *     useScreenLoad(corporateTelemetry, 'BookingPage');
 *     const flow = useFlowTimer(corporateTelemetry, 'BookingPage');
 *
 *     async function onBook() {
 *       const t = flow('create_booking');
 *       await createBooking(data);
 *       t.stop();
 *     }
 *   }
 */

import { OnecabTelemetry } from '../core';
import { useRouteChangeTracker, useFlushOnHide } from '../react';

export const corporateTelemetry = new OnecabTelemetry({
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL ?? '__SUPABASE_URL__',
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '__ANON_KEY__',
  appName: 'corporate_web',
  platform: 'web',
  appVersion: '1.0.0',
});

export function CorporateTelemetryProvider() {
  try {
    const { useLocation } = require('react-router-dom');
    const location = useLocation();
    useRouteChangeTracker(corporateTelemetry, location.pathname);
    useFlushOnHide(corporateTelemetry);
  } catch {
    useFlushOnHide(corporateTelemetry);
  }
  return null;
}
