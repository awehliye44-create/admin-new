/**
 * Corporate password-recovery helpers — resolve known corporate contacts and
 * provision Auth users when contact email has no auth.users row.
 * Pure enough for Deno edge; uses Supabase client types loosely.
 */

export type CorporateAuthEnsureResult =
  | { ok: true; created: boolean; userId: string }
  | { ok: false; reason: "not_corporate_contact" | "create_failed" };

export async function isKnownCorporateContactEmail(
  // deno-lint-ignore no-explicit-any
  admin: any,
  email: string,
): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;

  const checks: Array<{ table: string; column: string }> = [
    { table: "corporate_accounts", column: "contact_email" },
    { table: "corporate_users", column: "email" },
    { table: "corporate_account_requests", column: "contact_email" },
  ];

  for (const { table, column } of checks) {
    const { data, error } = await admin
      .from(table)
      .select("id")
      .ilike(column, normalized)
      .limit(1);
    if (error) {
      console.warn("[password-recovery] corporate contact lookup failed", {
        table,
        message: error.message,
      });
      continue;
    }
    if (Array.isArray(data) && data.length > 0) return true;
  }
  return false;
}

/**
 * If email is a known corporate contact but has no Auth user, create one
 * (email confirmed) and best-effort link corporate_users / corporate_user_accounts.
 */
export async function ensureCorporateAuthUserForRecovery(
  // deno-lint-ignore no-explicit-any
  admin: any,
  email: string,
): Promise<CorporateAuthEnsureResult> {
  const normalized = email.trim().toLowerCase();
  const known = await isKnownCorporateContactEmail(admin, normalized);
  if (!known) return { ok: false, reason: "not_corporate_contact" };

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email: normalized,
    email_confirm: true,
    user_metadata: {
      account_type: "corporate",
      source: "corporate_password_recovery",
    },
  });

  let userId: string | null = created?.user?.id ?? created?.id ?? null;
  let createdFlag = Boolean(userId);

  if (createError || !userId) {
    const msg = String(createError?.message ?? "").toLowerCase();
    const already =
      msg.includes("already") ||
      msg.includes("registered") ||
      msg.includes("exists");
    if (!already) {
      console.error("[password-recovery] corporate createUser failed", {
        message: createError?.message,
      });
      return { ok: false, reason: "create_failed" };
    }
    // Fetch existing by listing is expensive; generateLink after this path handles existing.
    // Try getUserByEmail via admin API if available.
    try {
      const { data: listed } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      const users = listed?.users ?? [];
      const hit = users.find((u: { email?: string }) => (u.email || "").toLowerCase() === normalized);
      userId = hit?.id ?? null;
      createdFlag = false;
    } catch (e) {
      console.warn("[password-recovery] corporate listUsers after exists failed", {
        message: e instanceof Error ? e.message : "unknown",
      });
    }
    if (!userId) {
      // User exists for generateLink even if we cannot resolve id for linking.
      return { ok: true, created: false, userId: "" };
    }
  }

  // Best-effort link corporate_users
  try {
    await admin
      .from("corporate_users")
      .update({ user_id: userId })
      .ilike("email", normalized)
      .is("user_id", null);
  } catch (e) {
    console.warn("[password-recovery] corporate_users link failed", {
      message: e instanceof Error ? e.message : "unknown",
    });
  }

  try {
    const { data: accounts } = await admin
      .from("corporate_accounts")
      .select("id")
      .ilike("contact_email", normalized)
      .limit(1);
    const accountId = accounts?.[0]?.id as string | undefined;
    if (accountId && userId) {
      const { data: existing } = await admin
        .from("corporate_user_accounts")
        .select("id, user_id")
        .eq("corporate_account_id", accountId)
        .limit(1);
      if (!existing?.length) {
        await admin.from("corporate_user_accounts").insert({
          corporate_account_id: accountId,
          user_id: userId,
          role: "admin",
        });
      } else if (!existing[0].user_id) {
        await admin
          .from("corporate_user_accounts")
          .update({ user_id: userId })
          .eq("id", existing[0].id);
      }
    }
  } catch (e) {
    console.warn("[password-recovery] corporate_user_accounts link failed", {
      message: e instanceof Error ? e.message : "unknown",
    });
  }

  return { ok: true, created: createdFlag, userId: userId || "" };
}
