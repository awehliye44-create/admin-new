/**
 * HOLD_AUTHORISED audit may overlap direct finalize, but is never fire-and-forget:
 * the session patch lands first and confirm settles the audit before responding.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { markPaymentSessionAuthorised } from "./paymentSessionSSOT.ts";

function fakeSupabase(opts: { auditDelayMs?: number; auditError?: string } = {}) {
  const log: string[] = [];
  let releaseAudit: () => void = () => {};
  const auditGate = new Promise<void>((r) => (releaseAudit = r));
  const client = {
    from(table: string) {
      if (table === "payment_sessions") {
        const q = {
          update(_body: unknown) {
            return q;
          },
          eq(_c: string, _v: unknown) {
            return q;
          },
          then(res: (v: { error: null }) => unknown) {
            log.push("session_patch");
            return Promise.resolve({ error: null }).then(res);
          },
        };
        return q;
      }
      if (table === "admin_payment_audit") {
        return {
          insert(_row: unknown) {
            log.push("audit_start");
            return {
              then(res: (v: { error: { message: string } | null }) => unknown) {
                return auditGate.then(() => {
                  log.push("audit_end");
                  return res({ error: opts.auditError ? { message: opts.auditError } : null });
                });
              },
            };
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return { client: client as never, log, releaseAudit };
}

Deno.test("deferAudit: session patch first, audit returned pending, finalize can run alongside", async () => {
  const db = fakeSupabase();
  const { audit } = await markPaymentSessionAuthorised(db.client, {
    providerOrderId: "order-1",
    clientActionId: "cai-1",
    deferAudit: true,
  });
  assertEquals(db.log[0], "session_patch");
  let auditDone = false;
  audit.then(() => (auditDone = true));
  db.log.push("finalize");
  await Promise.resolve();
  assertEquals(auditDone, false);
  db.releaseAudit();
  await audit;
  assertEquals(auditDone, true);
  assert(db.log.indexOf("finalize") < db.log.indexOf("audit_end"));
  assertEquals(db.log.includes("audit_end"), true);
});

Deno.test("deferAudit: audit failure is warned, never rejects (matches awaited path)", async () => {
  const db = fakeSupabase({ auditError: "insert failed" });
  const { audit } = await markPaymentSessionAuthorised(db.client, { providerOrderId: "o", deferAudit: true });
  db.releaseAudit();
  await audit;
  assertEquals(db.log.includes("audit_end"), true);
});

Deno.test("default path still awaits the audit before returning", async () => {
  const db = fakeSupabase();
  let returned = false;
  const p = markPaymentSessionAuthorised(db.client, { providerOrderId: "o" }).then(() => (returned = true));
  await new Promise((r) => setTimeout(r, 5));
  assertEquals(returned, false);
  db.releaseAudit();
  await p;
  assertEquals(db.log, ["session_patch", "audit_start", "audit_end"]);
});

Deno.test("confirm settles finalize AND audit before responding (no fire-and-forget)", () => {
  const src = Deno.readTextFileSync(new URL("../confirm-revolut-payment/index.ts", import.meta.url));
  const mark = src.indexOf("deferAudit: true");
  const settled = src.indexOf("await Promise.allSettled([", mark);
  const auditIn = src.indexOf("holdAuthorisedAudit,", settled);
  const respond = src.indexOf("return json({", settled);
  assert(mark > 0 && settled > mark && auditIn > settled && respond > auditIn);
  assert(src.includes('if (finalizeSettled.status === "rejected") throw finalizeSettled.reason;'));
  assertEquals(src.includes("void holdAuthorisedAudit"), false);
});
