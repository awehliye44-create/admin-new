export type GoTrueAuthContext = {
  supabaseUrl: string;
  anonKey: string;
  accessToken: string;
};

export function parseBearerToken(authHeader: string | null): string | null {
  if (!authHeader?.startsWith("Bearer ")) return null;
  const token = authHeader.slice("Bearer ".length).trim();
  return token || null;
}

export function phoneDigits(phone: string): string {
  return phone.replace(/\D/g, "");
}

export type GoTrueResult =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; status: number; message: string };

async function goTrueRequest(
  ctx: GoTrueAuthContext,
  path: string,
  init: RequestInit,
): Promise<GoTrueResult> {
  const res = await fetch(`${ctx.supabaseUrl}/auth/v1${path}`, {
    ...init,
    headers: {
      apikey: ctx.anonKey,
      Authorization: `Bearer ${ctx.accessToken}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  const data = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) {
    const message = String(
      data.msg ??
        data.error_description ??
        data.message ??
        data.error ??
        `HTTP ${res.status}`,
    );
    return { ok: false, status: res.status, message };
  }

  return { ok: true, data };
}

export async function goTrueUpdateUserPhone(
  ctx: GoTrueAuthContext,
  phone: string,
): Promise<GoTrueResult> {
  return goTrueRequest(ctx, "/user", {
    method: "PUT",
    body: JSON.stringify({ phone }),
  });
}

export async function goTrueResendPhoneChange(
  ctx: GoTrueAuthContext,
  phone: string,
): Promise<GoTrueResult> {
  return goTrueRequest(ctx, "/resend", {
    method: "POST",
    body: JSON.stringify({ type: "phone_change", phone }),
  });
}
