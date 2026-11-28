/** Offline test/audit-only helpers; not part of Edge uploads. */
import { VerificationAppType, androidIntentUrl, verificationAppScheme, NativeVerifyPath, nativeAppHandoffLocation, escapeHtmlAttr } from "../../../functions/_shared/accountEmailVerification.ts";


/**
 * Chrome/Samsung Gmail block HTTPS 302 → custom scheme.
 * intent:// with the real applicationId opens the installed app from a Custom Tab.
 */
export function accountEmailVerificationAndroidIntentUrl(
  appType: VerificationAppType,
  token: string,
  error?: string,
): string | null {
  return androidIntentUrl({
    appType,
    path: "auth/verify-email",
    token,
    error,
  });
}


/** Deep link into the holding screen after server-side confirm (no token). */
export function accountEmailVerifiedAppDeepLink(appType: VerificationAppType): string {
  const scheme = verificationAppScheme(appType);
  return `${scheme}://verify-email?app=${encodeURIComponent(appType)}&result=verified`;
}


/**
 * HTML interstitial for iOS Safari (and similar) that cannot follow Location: custom-scheme.
 * Deep link is fixed from appType/path/token — never from caller-supplied redirect URLs.
 */
export function nativeAppHandoffHtml(args: {
  appType: VerificationAppType;
  path: NativeVerifyPath;
  token?: string | null;
  error?: string | null;
}): string {
  const deepLink = nativeAppHandoffLocation({
    ...args,
    userAgent: "iPhone",
  });
  const href = escapeHtmlAttr(deepLink);
  const appLabel = args.appType === "driver"
    ? "ONECAB Driver"
    : args.appType === "admin"
    ? "ONECAB Admin"
    : "ONECAB";
  const title = args.error
    ? "Open the app to continue"
    : "Confirming your email";
  const body = args.error
    ? "This link could not finish in the browser. Open the app, then use Resend if needed."
    : "Tap below if the app does not open automatically.";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="refresh" content="0;url=${href}" />
  <title>${escapeHtmlAttr(title)}</title>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;margin:0;padding:32px 20px;background:#fff;color:#111;text-align:center}
    a.btn{display:inline-block;margin-top:20px;padding:14px 22px;border-radius:12px;background:#111;color:#fff;text-decoration:none;font-weight:700}
    p{line-height:1.45;color:#444}
  </style>
  <script>location.replace(${JSON.stringify(deepLink)});</script>
</head>
<body>
  <h1>${escapeHtmlAttr(title)}</h1>
  <p>${escapeHtmlAttr(body)}</p>
  <p><a class="btn" href="${href}">Open ${escapeHtmlAttr(appLabel)}</a></p>
</body>
</html>`;
}

export * from "../../../functions/_shared/accountEmailVerification.ts";
