/** Shared CORS headers for customer booking + place lookup edges (Capacitor WebView preflight). */
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version, x-onecab-native-client, baggage, sentry-trace",
};
