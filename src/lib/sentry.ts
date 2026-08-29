import * as Sentry from "@sentry/react";

/**
 * Sentry initialisation – ADMIN PANEL ONLY.
 * DSN from VITE_SENTRY_DSN (never hardcode). Boots safely when unset.
 * This file must NOT be imported by any other ONECAB app.
 */
export function initSentry() {
  const dsn = (import.meta.env.VITE_SENTRY_DSN as string | undefined)?.trim();
  if (!dsn) {
    if (import.meta.env.DEV) {
      console.info("[sentry] disabled — VITE_SENTRY_DSN unset");
    }
    return;
  }

  const environment =
    (import.meta.env.VITE_APP_ENV as string | undefined)?.trim() ||
    (import.meta.env.MODE as string | undefined) ||
    "production";

  Sentry.init({
    dsn,
    enabled: true,
    environment,
    sendDefaultPii: false,
    release: `onecab-admin-panel@${import.meta.env.VITE_APP_VERSION ?? "1.0.0"}`,

    integrations: (defaults) => {
      // Remove the BrowserApiErrors integration that wraps addEventListener
      // callbacks with sentryWrapped — this breaks React's internal
      // event dispatching and causes context providers to appear missing.
      const filtered = defaults.filter((i) => i.name !== "BrowserApiErrors");
      filtered.push(Sentry.browserTracingIntegration());
      return filtered;
    },

    tracesSampleRate: 0.3,

    beforeSend(event) {
      if (event.user) {
        delete event.user.email;
        delete event.user.username;
        delete event.user.ip_address;
        delete event.user.name;
      }
      if (event.request?.headers) {
        const headers = { ...event.request.headers };
        for (const key of Object.keys(headers)) {
          if (/authorization|cookie|token|secret|api-?key/i.test(key)) {
            headers[key] = "[redacted]";
          }
        }
        event.request.headers = headers;
      }
      return event;
    },

    initialScope: {
      tags: {
        app_name: "onecab-admin-panel",
        role: "admin",
      },
    },
  });
}

/**
 * Set authenticated admin user context on Sentry (id only — no email/PII).
 * Call after sign-in / session restore.
 */
export function setSentryUser(user: { id: string; email?: string | null }) {
  // id only — never attach email / PII to Sentry user context
  Sentry.setUser({
    id: user.id,
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
