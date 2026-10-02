import type { VerificationAppType } from "./accountEmailVerification.ts";
import { EMAIL_VERIFICATION_EXPIRY_MINUTES } from "./emailVerificationPolicy.ts";

export const VERIFICATION_EMAIL_SUBJECT = "Verify your ONECAB account";

const BRAND_YELLOW = "#FFD700";
const BRAND_DARK = "#0B0B0B";
const BRAND_SURFACE = "#141414";
const FOOTER_PHONE = "01908 831211";
const FOOTER_WEBSITE = "www.onecab.net";

export interface VerificationEmailContent {
  subject: string;
  html: string;
  text: string;
}

export interface RenderVerificationEmailArgs {
  appType: VerificationAppType;
  firstName: string;
  verifyUrl: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function variantCopy(appType: VerificationAppType): {
  headerTitle: string;
  headerSubtitle: string;
  body: string;
} {
  if (appType === "driver") {
    return {
      headerTitle: "ONECAB DRIVER",
      headerSubtitle: "",
      body:
        "Welcome to ONECAB Driver. To continue your driver account setup, please verify your email address.",
    };
  }

  return {
    headerTitle: "ONECAB",
    headerSubtitle: "Premium ride booking platform",
    body:
      "Welcome to ONECAB. To complete your account setup and start booking rides, please verify your email address.",
  };
}

function securityCopy(): string {
  return `This verification link expires in ${EMAIL_VERIFICATION_EXPIRY_MINUTES} minutes. If you did not create a ONECAB account, you can safely ignore this email.`;
}

function footerText(): string {
  return `ONECAB\n${FOOTER_WEBSITE}\n${FOOTER_PHONE}`;
}

function renderHtml(args: RenderVerificationEmailArgs): string {
  const safeFirstName = escapeHtml(args.firstName);
  const safeVerifyUrl = escapeHtml(args.verifyUrl);
  const copy = variantCopy(args.appType);
  const subtitleBlock = copy.headerSubtitle
    ? `<p style="margin:8px 0 0;font-size:14px;line-height:20px;color:#E5E5E5;font-weight:400;">${copy.headerSubtitle}</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${VERIFICATION_EMAIL_SUBJECT}</title>
</head>
<body style="margin:0;padding:0;background-color:${BRAND_DARK};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color:${BRAND_DARK};padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:560px;background-color:${BRAND_SURFACE};border:1px solid #2A2A2A;border-radius:12px;overflow:hidden;">
          <tr>
            <td style="padding:28px 24px 20px;text-align:center;border-bottom:3px solid ${BRAND_YELLOW};">
              <div style="font-size:28px;line-height:32px;font-weight:800;letter-spacing:2px;color:${BRAND_YELLOW};">${copy.headerTitle}</div>
              ${subtitleBlock}
            </td>
          </tr>
          <tr>
            <td style="padding:28px 24px;color:#FFFFFF;">
              <p style="margin:0 0 16px;font-size:16px;line-height:24px;">Hello ${safeFirstName},</p>
              <p style="margin:0 0 24px;font-size:15px;line-height:24px;color:#F0F0F0;">${copy.body}</p>
              <table role="presentation" cellspacing="0" cellpadding="0" style="margin:0 auto 24px;">
                <tr>
                  <td align="center" style="border-radius:8px;background-color:${BRAND_YELLOW};">
                    <a href="${safeVerifyUrl}" style="display:inline-block;padding:14px 28px;font-size:14px;font-weight:700;letter-spacing:0.5px;color:#111111;text-decoration:none;">VERIFY EMAIL</a>
                  </td>
                </tr>
              </table>
              <p style="margin:0;font-size:13px;line-height:20px;color:#A8A8A8;">${securityCopy()}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 24px 28px;border-top:1px solid #2A2A2A;text-align:center;">
              <p style="margin:0 0 6px;font-size:13px;line-height:20px;font-weight:700;color:${BRAND_YELLOW};">ONECAB</p>
              <p style="margin:0 0 4px;font-size:12px;line-height:18px;color:#CFCFCF;"><a href="https://${FOOTER_WEBSITE}" style="color:#CFCFCF;text-decoration:none;">${FOOTER_WEBSITE}</a></p>
              <p style="margin:0;font-size:12px;line-height:18px;color:#CFCFCF;">${FOOTER_PHONE}</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function renderPlainText(args: RenderVerificationEmailArgs): string {
  const copy = variantCopy(args.appType);
  const header = copy.headerSubtitle
    ? `${copy.headerTitle}\n${copy.headerSubtitle}`
    : copy.headerTitle;

  return `${header}

Hello ${args.firstName},

${copy.body}

Verify your email:
${args.verifyUrl}

${securityCopy()}

${footerText()}`;
}

export function resolveVerificationFirstName(
  metadata: Record<string, unknown> | null | undefined,
  profileFirstName?: string | null,
): string {
  const fromMeta = String(metadata?.first_name ?? "").trim();
  if (fromMeta) return fromMeta;

  const fromProfile = String(profileFirstName ?? "").trim();
  if (fromProfile) return fromProfile;

  return "there";
}

export function renderVerificationEmail(args: RenderVerificationEmailArgs): VerificationEmailContent {
  return {
    subject: VERIFICATION_EMAIL_SUBJECT,
    html: renderHtml(args),
    text: renderPlainText(args),
  };
}
