/**
 * Public HTTPS bridge for Driver / Customer password-reset email buttons.
 * GET ?app=driver|customer&h=<sealed handoff>  →  302 into the native app.
 *
 * Read-only: no auth state is consumed here, so link scanners that prefetch the
 * URL cannot invalidate it. Tokens are never logged.
 */

import { getRecoveryRedirect } from "../_shared/passwordRecoverySSOT.ts";
import {
  openRecoveryHandoff,
  parseNativeRecoveryApp,
  passwordRecoveryHandoffLocation,
  recoveryHandoffSecret,
} from "../_shared/passwordRecoveryHandoff.ts";
import { isAndroidUserAgent } from "../_shared/accountEmailVerification.ts";

function redirectResponse(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

Deno.serve(async (req) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  }

  const url = new URL(req.url);
  const app = parseNativeRecoveryApp(url.searchParams.get("app"));
  if (!app) {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  const nativeRedirect = getRecoveryRedirect(app, {
    DRIVER_PASSWORD_RESET_REDIRECT: Deno.env.get("DRIVER_PASSWORD_RESET_REDIRECT") ?? undefined,
    CUSTOMER_PASSWORD_RESET_REDIRECT: Deno.env.get("CUSTOMER_PASSWORD_RESET_REDIRECT") ??
      undefined,
  });
  const secret = recoveryHandoffSecret({
    PASSWORD_RECOVERY_HANDOFF_SECRET: Deno.env.get("PASSWORD_RECOVERY_HANDOFF_SECRET") ??
      undefined,
    SUPABASE_SERVICE_ROLE_KEY: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? undefined,
  });

  const handoff = String(url.searchParams.get("h") ?? "").trim();
  const opened = handoff
    ? await openRecoveryHandoff({ token: handoff, app, secret })
    : { ok: false as const, reason: "invalid" as const };

  const userAgent = req.headers.get("user-agent");
  console.log("[password-recovery-link]", JSON.stringify({
    app,
    method: req.method,
    outcome: opened.ok ? "ok" : opened.reason,
    platform: isAndroidUserAgent(userAgent) ? "android" : "other",
  }));

  return redirectResponse(passwordRecoveryHandoffLocation({
    app,
    nativeRedirect,
    session: opened.ok ? opened.session : null,
    userAgent,
  }));
});
