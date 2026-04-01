/**
 * Admin Panel — Telemetry Bootstrap
 * ===================================
 * Auto-tracks route changes and API calls.
 * Import once in AdminShell or App-level layout.
 */

import { useLocation } from 'react-router-dom';
import { adminTelemetry } from '@/hooks/useAdminTelemetry';
import { useFlushOnHide, useRouteChangeTracker } from '@/lib/telemetry';
import { installFetchInterceptor } from '@/lib/telemetry';

// Install fetch interceptor once at module level
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
if (SUPABASE_URL) {
  installFetchInterceptor(adminTelemetry, SUPABASE_URL);
}

/**
 * Drop this component inside the router tree to auto-track
 * route changes and flush on page hide.
 */
export function AdminTelemetryProvider() {
  const location = useLocation();
  useRouteChangeTracker(adminTelemetry, location.pathname);
  useFlushOnHide(adminTelemetry);
  return null;
}
