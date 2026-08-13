/**
 * Admin alert delivery — in-app notifications, email (Resend), and web push.
 */
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { sendResendEmail } from "./resendMail.ts";

export type AdminNotificationCategory = "payment" | "system" | "trip";

export type SendAdminNotificationArgs = {
  type: string;
  title: string;
  body: string;
  category?: AdminNotificationCategory;
  priority?: "low" | "normal" | "high" | "urgent";
  actionUrl?: string;
  actionLabel?: string;
  data?: Record<string, unknown>;
  /** Dedupe key — suppress repeat alerts within cooldown window. */
  alertKey?: string;
  cooldownMinutes?: number;
  emailTag?: string;
};

type NotificationPrefs = {
  enabled?: boolean;
  payment_alerts?: boolean;
  system_alerts?: boolean;
  trip_updates?: boolean;
  driver_alerts?: boolean;
};

async function loadNotificationPrefs(
  supabase: SupabaseClient,
  key: "email_notifications" | "push_notifications",
): Promise<NotificationPrefs> {
  const { data } = await supabase
    .from("notification_settings")
    .select("setting_value")
    .eq("setting_key", key)
    .maybeSingle();
  return (data?.setting_value as NotificationPrefs | null) ?? { enabled: true, payment_alerts: true };
}

async function wasRecentlyAlerted(
  supabase: SupabaseClient,
  alertKey: string,
  cooldownMinutes: number,
): Promise<boolean> {
  const since = new Date(Date.now() - cooldownMinutes * 60_000).toISOString();
  const { data } = await supabase
    .from("notifications")
    .select("id")
    .eq("target_audience", "admins")
    .gte("created_at", since)
    .contains("metadata", { alert_key: alertKey })
    .limit(1);
  return (data?.length ?? 0) > 0;
}

async function listAdminRecipients(supabase: SupabaseClient): Promise<{
  userIds: string[];
  emails: string[];
}> {
  const { data: roleRows } = await supabase
    .from("user_roles")
    .select("user_id")
    .eq("role", "admin");

  const userIds = [...new Set((roleRows ?? []).map((r) => String(r.user_id)).filter(Boolean))];
  const emails: string[] = [];

  const fallback = (Deno.env.get("ADMIN_ALERT_EMAILS") ?? "admin@onecab.net,info@onecab.net")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  emails.push(...fallback);

  for (const userId of userIds) {
    try {
      const { data, error } = await supabase.auth.admin.getUserById(userId);
      const email = data?.user?.email?.trim();
      if (!error && email && !emails.includes(email)) {
        emails.push(email);
      }
    } catch {
      /* non-fatal */
    }
  }

  return { userIds, emails: [...new Set(emails)] };
}

function shouldSendPaymentAlert(
  emailPrefs: NotificationPrefs,
  pushPrefs: NotificationPrefs,
): { email: boolean; push: boolean } {
  const email = emailPrefs.enabled !== false && emailPrefs.payment_alerts !== false;
  const push = pushPrefs.enabled !== false && pushPrefs.payment_alerts !== false;
  return { email, push };
}

export async function sendAdminNotification(
  supabase: SupabaseClient,
  args: SendAdminNotificationArgs,
): Promise<{
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  in_app?: boolean;
  emails_sent?: number;
  push_sent?: number;
}> {
  const category = args.category ?? "payment";
  const priority = args.priority ?? "urgent";
  const cooldownMinutes = args.cooldownMinutes ?? 15;
  const alertKey = args.alertKey ?? `${args.type}:${args.data?.provider_order_id ?? args.data?.trip_id ?? "general"}`;

  if (await wasRecentlyAlerted(supabase, alertKey, cooldownMinutes)) {
    return { ok: true, skipped: true, reason: "cooldown" };
  }

  const metadata = {
    alert_key: alertKey,
    alert_type: args.type,
    ...(args.data ?? {}),
  };

  const { error: insertError } = await supabase.from("notifications").insert({
    type: "alert",
    category,
    title: args.title,
    message: args.body,
    priority,
    target_audience: "admins",
    action_url: args.actionUrl ?? "/financial-reconciliation?tab=overview",
    action_label: args.actionLabel ?? "Review holds",
    metadata,
    is_read: false,
    is_dismissed: false,
  });

  if (insertError) {
    console.warn("[adminNotification] in-app insert failed", insertError.message);
  }

  const [emailPrefs, pushPrefs] = await Promise.all([
    loadNotificationPrefs(supabase, "email_notifications"),
    loadNotificationPrefs(supabase, "push_notifications"),
  ]);

  const channel = category === "payment"
    ? shouldSendPaymentAlert(emailPrefs, pushPrefs)
    : { email: emailPrefs.enabled !== false, push: pushPrefs.enabled !== false };

  const { userIds, emails } = await listAdminRecipients(supabase);
  let emailsSent = 0;
  let pushSent = 0;

  if (channel.email && emails.length > 0) {
    const subject = `[ONECAB Admin] ${args.title}`;
    const html = `
      <p><strong>${args.title}</strong></p>
      <p>${args.body}</p>
      <p><a href="https://adminonecab.net/financial-reconciliation?tab=overview">Open Financial Reconciliation</a></p>
      <p style="color:#666;font-size:12px">Alert type: ${args.type}</p>
    `;
    for (const to of emails) {
      const sent = await sendResendEmail({
        to,
        subject,
        html,
        text: `${args.title}\n\n${args.body}`,
        tag: args.emailTag ?? "admin_payment_alert",
      });
      if (sent.ok) emailsSent++;
    }
  }

  if (channel.push && userIds.length > 0) {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    for (const userId of userIds) {
      try {
        const res = await fetch(`${supabaseUrl}/functions/v1/send-push-notification`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${serviceKey}`,
            apikey: serviceKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            userId,
            title: args.title,
            body: args.body,
            url: args.actionUrl ?? "/financial-reconciliation?tab=overview",
            tag: alertKey,
            requireInteraction: true,
          }),
        });
        if (res.ok) {
          const payload = await res.json().catch(() => ({}));
          pushSent += Number(payload?.sent ?? 0);
        }
      } catch (err) {
        console.warn("[adminNotification] push failed", userId, err);
      }
    }
  }

  console.info("ADMIN_NOTIFICATION_SENT", {
    type: args.type,
    alert_key: alertKey,
    in_app: !insertError,
    emails_sent: emailsSent,
    push_sent: pushSent,
  });

  return {
    ok: true,
    in_app: !insertError,
    emails_sent: emailsSent,
    push_sent: pushSent,
  };
}
