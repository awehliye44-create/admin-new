/**
 * Branded ONECAB password-reset email HTML.
 * Reuses invoice email brand tokens (black header, yellow accent, grey page).
 * No Deno/npm imports — vitest-safe via @shared.
 */

import { isAllowedPasswordResetRecoveryUrl } from "./passwordRecoverySSOT.ts";

const BRAND = {
  black: "#0B0F14",
  yellow: "#FFD400",
  white: "#FFFFFF",
  bodyBg: "#F4F4F5",
  muted: "#6B7280",
  text: "#111827",
  bodyText: "#4B5563",
  noticeBg: "#FFF8D8",
  noticeBorder: "#F4D35E",
  noticeText: "#554500",
} as const;

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const PASSWORD_RESET_EMAIL_SUBJECT = "Reset your ONECAB password";

export function buildPasswordResetEmail(args: {
  recoveryUrl: string;
  app: "driver" | "customer" | "corporate";
  logoUrl?: string;
}): { subject: string; html: string; text: string } {
  const recoveryUrl = args.recoveryUrl.trim();
  if (!isAllowedPasswordResetRecoveryUrl(recoveryUrl)) {
    throw new Error("recoveryUrl must be https or a native ONECAB deep link");
  }
  const safeUrl = esc(recoveryUrl);
  const logoUrl = args.logoUrl?.trim();
  const appLabel =
    args.app === "driver" ? "Driver" : args.app === "corporate" ? "Corporate" : "Customer";
  const continueHint =
    args.app === "corporate"
      ? "Open this email on your computer or phone and tap Reset password to continue in the ONECAB Corporate portal."
      : "Open this email on your phone and tap Reset password to continue in the ONECAB app.";

  const logoBlock = logoUrl
    ? `<img src="${esc(logoUrl)}" alt="ONECAB" width="150" style="display:block;width:150px;max-width:100%;height:auto;border:0;outline:none;text-decoration:none;" />`
    : `<div style="font-size:28px;font-weight:700;color:${BRAND.white};letter-spacing:2px;line-height:1;">ONECAB</div>`;

  const subject = PASSWORD_RESET_EMAIL_SUBJECT;

  const text = `ONECAB — Reset your password

We received a request to reset the password for your ONECAB ${appLabel} account.

${continueHint}

If you did not request a password reset, you can safely ignore this email. Your current password will remain unchanged.

ONECAB will never ask you to send your password by email, text message or phone.

—
ONECAB
Safe, reliable journeys with ONECAB.
This is an automated security email. Do not reply.`;

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light" />
  <meta name="supported-color-schemes" content="light" />
  <title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;width:100%;background-color:${BRAND.bodyBg};font-family:Arial,Helvetica,sans-serif;color:${BRAND.text};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;line-height:1px;font-size:1px;">
    Reset your ONECAB password securely.
  </div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background-color:${BRAND.bodyBg};border-collapse:collapse;">
    <tr>
      <td align="center" style="padding:32px 12px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px;border-collapse:collapse;">
          <tr>
            <td align="center" style="background-color:${BRAND.black};padding:28px 24px;border-radius:18px 18px 0 0;">
              ${logoBlock}
              <div style="margin-top:14px;font-size:12px;font-weight:600;color:${BRAND.yellow};letter-spacing:1.5px;text-transform:uppercase;">Password reset</div>
            </td>
          </tr>
          <tr>
            <td style="height:4px;background-color:${BRAND.yellow};font-size:0;line-height:0;">&nbsp;</td>
          </tr>
          <tr>
            <td style="background-color:${BRAND.white};padding:42px 36px 34px;">
              <h1 style="margin:0 0 18px;color:${BRAND.text};font-size:28px;line-height:36px;font-weight:700;text-align:center;">
                Reset your password
              </h1>
              <p style="margin:0 0 14px;color:${BRAND.bodyText};font-size:16px;line-height:25px;text-align:center;">
                We received a request to reset the password for your ONECAB account.
              </p>
              <p style="margin:0 0 30px;color:${BRAND.bodyText};font-size:16px;line-height:25px;text-align:center;">
                Tap the button below to create a new password.
              </p>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;">
                <tr>
                  <td align="center">
                    <a href="${safeUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;min-width:220px;padding:16px 26px;background-color:${BRAND.black};color:${BRAND.white};font-size:16px;line-height:20px;font-weight:700;text-decoration:none;text-align:center;border-radius:10px;">
                      Reset password
                    </a>
                  </td>
                </tr>
              </table>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:32px;border-collapse:collapse;">
                <tr>
                  <td style="padding:18px;background-color:${BRAND.noticeBg};border:1px solid ${BRAND.noticeBorder};border-radius:10px;">
                    <p style="margin:0;color:${BRAND.noticeText};font-size:14px;line-height:21px;">
                      For your security, only use this link if you requested a password reset. ONECAB will never ask you to send your password by email, text message or phone.
                    </p>
                  </td>
                </tr>
              </table>
              <hr style="margin:32px 0 24px;border:0;border-top:1px solid #E5E7EB;" />
              <p style="margin:0;color:${BRAND.muted};font-size:14px;line-height:22px;text-align:center;">
                If you did not request this password reset, you can safely ignore this email. Your current password will remain unchanged.
              </p>
            </td>
          </tr>
          <tr>
            <td align="center" style="background-color:${BRAND.black};padding:24px;border-radius:0 0 18px 18px;">
              <p style="margin:0 0 6px;color:${BRAND.white};font-size:14px;line-height:20px;font-weight:700;">ONECAB</p>
              <p style="margin:0;color:#D1D5DB;font-size:12px;line-height:18px;">Safe, reliable journeys with ONECAB.</p>
              <p style="margin:14px 0 0;color:#9CA3AF;font-size:11px;line-height:17px;">This is an automated security email. Do not reply.</p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:20px 16px 0;">
              <p style="margin:0;color:#9CA3AF;font-size:11px;line-height:17px;">© ONECAB LIMITED. All rights reserved.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, html, text };
}
