/**
 * B1 — session-held advisory fence (closes check-to-use race).
 *
 * Durable TTL lease alone allows: fence-check → stall → TTL reclaim by peer →
 * stale mutation. A dedicated Postgres session holding pg_try_advisory_lock for
 * the whole Edge request prevents any peer from entering the critical section
 * while this worker's connection is alive. Connection drop ⇒ lock auto-release
 * (automatic recovery).
 *
 * Requires SUPABASE_DB_URL (already provisioned on the Edge runtime).
 */

import postgres from "npm:postgres@3.4.5";
import {
  EXPIRE_OFFERS_ADVISORY_K1,
  EXPIRE_OFFERS_ADVISORY_K2,
} from "./expireOffersSessionFenceModel.ts";

export {
  EXPIRE_OFFERS_ADVISORY_K1,
  EXPIRE_OFFERS_ADVISORY_K2,
  canPeerReclaimWhileHolderAlive,
} from "./expireOffersSessionFenceModel.ts";

export type SessionFence = {
  acquired: boolean;
  reason?: string;
  release: () => Promise<void>;
};

function resolveDbUrl(
  raw: string | undefined = typeof Deno !== "undefined"
    ? Deno.env.get("SUPABASE_DB_URL")
    : undefined,
): string | null {
  if (raw == null || raw.trim().length < 20) return null;
  return raw.trim();
}

/**
 * Try acquire session advisory lock. Caller must await release() in finally.
 * Fail closed: missing DB URL ⇒ not acquired (do not run unfenced critical section).
 */
export async function tryAcquireExpireOffersSessionFence(
  dbUrl: string | null = resolveDbUrl(),
): Promise<SessionFence> {
  const noop = async () => {};
  if (!dbUrl) {
    return { acquired: false, reason: "missing_supabase_db_url", release: noop };
  }

  let sql: ReturnType<typeof postgres> | null = null;
  try {
    sql = postgres(dbUrl, {
      max: 1,
      idle_timeout: 0,
      connect_timeout: 10,
      prepare: false,
    });
    const rows = await sql`
      SELECT pg_try_advisory_lock(${EXPIRE_OFFERS_ADVISORY_K1}, ${EXPIRE_OFFERS_ADVISORY_K2}) AS ok
    `;
    const ok = rows[0]?.ok === true;
    if (!ok) {
      await sql.end({ timeout: 2 });
      return { acquired: false, reason: "advisory_busy", release: noop };
    }
    const held = sql;
    return {
      acquired: true,
      release: async () => {
        try {
          await held`SELECT pg_advisory_unlock(${EXPIRE_OFFERS_ADVISORY_K1}, ${EXPIRE_OFFERS_ADVISORY_K2})`;
        } catch {
          // Connection drop also releases the lock.
        } finally {
          try {
            await held.end({ timeout: 2 });
          } catch {
            /* ignore */
          }
        }
      },
    };
  } catch (e) {
    if (sql) {
      try {
        await sql.end({ timeout: 2 });
      } catch {
        /* ignore */
      }
    }
    return {
      acquired: false,
      reason: `advisory_error:${String(e)}`,
      release: noop,
    };
  }
}
