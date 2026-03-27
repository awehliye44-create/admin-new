import * as Sentry from "@sentry/react";

/**
 * Sentry initialisation – ADMIN PANEL ONLY.
 * DSN is scoped to the onecab-admin-panel Sentry project.
 * This file must NOT be imported by any other ONECAB app.
 */
export function initSentry() {
  Sentry.init({
    dsn: "https://54e050c3aa8c5fb508ab5efd230dd256@o4510726239551488.ingest.de.sentry.io/4511116063735888",
    sendDefaultPii: true,

    // Performance tracing — use only non-component-wrapping integrations
    integrations: [
      Sentry.browserTracingIntegration({
        // Disable automatic React component instrumentation
        // which can interfere with React context providers
        enableInp: true,
      }),
    ],
    tracesSampleRate: 0.3,

    // Global tags on every event
    initialScope: {
      tags: {
        app_name: "onecab-admin-panel",
        role: "admin",
      },
    },

    // Prevent Sentry from wrapping React callbacks that break context
    defaultIntegrations: undefined,
  });
}

/**
 * Set authenticated admin user context on Sentry.
 * Call after sign-in / session restore.
 */
export function setSentryUser(user: { id: string; email?: string | null }) {
  Sentry.setUser({
    id: user.id,
    email: user.email ?? undefined,
  });
  Sentry.setTag("user_id", user.id);
}

/**
 * Clear user context on sign-out.
 */
export function clearSentryUser() {
  Sentry.setUser(null);
  Sentry.setTag("user_id", undefined);
}
