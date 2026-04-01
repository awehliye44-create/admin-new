/**
 * ONECAB Telemetry — Guest Booking Web Integration
 * ==================================================
 * Drop-in integration for https://guest.onecab.net/
 *
 * SETUP:
 * 1. Copy core.ts, react.ts, fetchInterceptor.ts into your project
 * 2. Create this file as your singleton
 * 3. Import and use as shown below
 *
 * EXAMPLE — App-level setup (e.g. GuestApp.tsx):
 *
 *   import { guestTelemetry, GuestTelemetryProvider } from './telemetry/guestWeb';
 *   import { installFetchInterceptor } from './telemetry/fetchInterceptor';
 *
 *   // Install once at startup
 *   installFetchInterceptor(guestTelemetry, SUPABASE_URL);
 *
 *   function App() {
 *     return (
 *       <Router>
 *         <GuestTelemetryProvider />
 *         <Routes>...</Routes>
 *       </Router>
 *     );
 *   }
 *
 * EXAMPLE — Per-screen usage:
 *
 *   import { guestTelemetry } from './telemetry/guestWeb';
 *   import { useScreenLoad, useFlowTimer } from './telemetry/react';
 *
 *   function QuotePage() {
 *     useScreenLoad(guestTelemetry, 'QuotePage');
 *     const flow = useFlowTimer(guestTelemetry, 'QuotePage');
 *
 *     async function onGetQuote() {
 *       const t = flow('get_quote');
 *       await fetchQuote();
 *       t.stop();
 *     }
 *   }
 *
 * SCREENS TO INSTRUMENT:
 *   - LandingPage       → useScreenLoad
 *   - QuotePage          → useScreenLoad + flow('get_quote')
 *   - CheckoutPage       → useScreenLoad + flow('checkout_submit')
 *   - PaymentPage        → useScreenLoad + flow('payment_submit')
 *   - BookingConfirmation→ useScreenLoad
 */

import { OnecabTelemetry } from './core';
import { useRouteChangeTracker, useFlushOnHide } from './react';

export const guestTelemetry = new OnecabTelemetry({
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL ?? '__SUPABASE_URL__',
  supabaseAnonKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '__ANON_KEY__',
  appName: 'guest_web',
  platform: 'web',
  appVersion: '1.0.0',
});

/** Drop into your router tree for auto route tracking */
export function GuestTelemetryProvider() {
  // This hook needs useLocation() from react-router
  // Wrap in a try since guest web may use different routing
  try {
    const { useLocation } = require('react-router-dom');
    const location = useLocation();
    useRouteChangeTracker(guestTelemetry, location.pathname);
    useFlushOnHide(guestTelemetry);
  } catch {
    useFlushOnHide(guestTelemetry);
  }
  return null;
}
