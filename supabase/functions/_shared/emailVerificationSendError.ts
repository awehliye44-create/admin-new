const RESEND_SANDBOX_PATTERNS = [
  /you can only send testing emails to your own email address/i,
  /verify a domain at resend\.com\/domains/i,
  /onboarding@resend\.dev/i,
];

export function mapEmailVerificationSendError(raw: string | null | undefined): string {
  const message = typeof raw === "string" ? raw.trim() : "";
  if (!message) {
    return "We couldn't send a verification email right now. Please try again in a few minutes or contact support@onecab.com for help.";
  }

  if (RESEND_SANDBOX_PATTERNS.some((pattern) => pattern.test(message))) {
    return "We couldn't send a verification email to this address yet. Email delivery is still being configured — please contact support@onecab.com for help completing verification.";
  }

  if (/RESEND_API_KEY is not configured|RESEND_API_KEY is misconfigured/i.test(message)) {
    return "Email verification is temporarily unavailable. Please try again later or contact support@onecab.com.";
  }

  if (/failed to send email/i.test(message)) {
    return "We couldn't send a verification email right now. Please try again in a few minutes or contact support@onecab.com for help.";
  }

  if (/resend\.com|resend\.dev|re_[a-z0-9]/i.test(message)) {
    return "We couldn't send a verification email right now. Please try again in a few minutes or contact support@onecab.com for help.";
  }

  return message.length > 160
    ? "We couldn't send a verification email right now. Please try again in a few minutes or contact support@onecab.com for help."
    : message;
}
