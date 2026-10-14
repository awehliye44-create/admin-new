/**
 * Lock: every named runtime import reachable from an Edge Function entrypoint
 * must be exported by its module. A missing export is a worker boot error —
 * the function returns 503 on every call (abandon-payment-session was down
 * this way from 2026-09-24 to 2026-10-07).
 * If this fails, fix the code — never delete or soften the lock.
 */
import { assert } from "https://deno.land/std@0.224.0/assert/assert.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/assert_equals.ts";
import { fromFileUrl } from "https://deno.land/std@0.224.0/path/from_file_url.ts";
import {
  COMMISSION_WALLET_ENTRY_TYPE,
  isDriverVisibleCommissionWalletEntryType,
} from "../../functions/_shared/commissionWalletSSOT.ts";
import { formatPenceSigned, formatPenceWithCurrency } from "../../functions/_shared/currency.ts";

const FUNCTIONS_ROOT = fromFileUrl(new URL("../../functions", import.meta.url));

/**
 * Pre-existing: the Revolut Business relay client never shipped these exports.
 * Money-moving code — must be implemented deliberately, not stubbed. This list
 * may only shrink.
 */
const KNOWN_MISSING_EXPORTS = new Set([
  "admin-sync-company-transfer-provider-status/index.ts -> ../_shared/revolutBusinessRelayClient.ts lacks relayCompanyTransferPaymentStatus",
  "admin-submit-company-transfer-payment/index.ts -> ../_shared/revolutBusinessRelayClient.ts lacks relayApprovedCompanyTransferPayment",
  "admin-finalize-company-transfer-completion/index.ts -> ../_shared/revolutBusinessRelayClient.ts lacks relayCompanyTransferPaymentStatus",
]);

function isExported(mod: string, name: string): boolean {
  return new RegExp(
    `export\\s+(?:declare\\s+)?(?:async\\s+)?(?:function\\*?|const|let|var|class|enum|type|interface|abstract\\s+class)\\s+${name}\\b` +
      `|export\\s*(?:type\\s*)?\\{[^}]*\\b${name}\\b[^}]*\\}` +
      `|export\\s*\\*\\s*from`,
  ).test(mod);
}

function findMissingNamedExports(): string[] {
  const cache = new Map<string, string | null>();
  const read = (path: string) => {
    if (!cache.has(path)) {
      try {
        cache.set(path, Deno.readTextFileSync(path));
      } catch {
        cache.set(path, null);
      }
    }
    return cache.get(path)!;
  };
  const seen = new Set<string>();
  const problems = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = read(file);
    if (src == null) return;
    const dir = file.slice(0, file.lastIndexOf("/"));
    for (const m of src.matchAll(/import\s+(type\s+)?\{([^}]+)\}\s*from\s*"(\.{1,2}\/[^"]+)"/g)) {
      if (m[1]) continue;
      const target = new URL(m[3], `file://${dir}/`).pathname;
      const mod = read(target);
      const rel = file.slice(FUNCTIONS_ROOT.length + 1);
      if (mod == null) {
        problems.add(`${rel} -> missing module ${m[3]}`);
        continue;
      }
      for (const raw of m[2].split(",")) {
        const t = raw.trim();
        if (!t || t.startsWith("type ")) continue;
        const name = t.split(/\s+as\s+/)[0].trim();
        if (!isExported(mod, name)) problems.add(`${rel} -> ${m[3]} lacks ${name}`);
      }
      visit(target);
    }
  };
  for (const entry of Deno.readDirSync(FUNCTIONS_ROOT)) {
    if (!entry.isDirectory || entry.name.startsWith("_")) continue;
    const index = `${FUNCTIONS_ROOT}/${entry.name}/index.ts`;
    try {
      Deno.statSync(index);
    } catch {
      continue;
    }
    visit(index);
  }
  return [...problems];
}

Deno.test("every Edge Function's named runtime imports exist (no boot-time 503)", () => {
  const unexpected = findMissingNamedExports().filter((p) => !KNOWN_MISSING_EXPORTS.has(p));
  assertEquals(unexpected, [], "missing export ⇒ worker boot error ⇒ 503 on every call");
});

Deno.test("Commission Wallet: Driver sees credits only, never commission internals", () => {
  for (const t of ["TOP_UP_CREDIT", "welcome_credit", "PROMOTIONAL_CREDIT", "ADMIN_CREDIT"]) {
    assert(isDriverVisibleCommissionWalletEntryType(t), t);
  }
  for (const t of [
    COMMISSION_WALLET_ENTRY_TYPE.COMMISSION_DEDUCTION,
    COMMISSION_WALLET_ENTRY_TYPE.COMMISSION_DEDUCTION_REVERSAL,
    COMMISSION_WALLET_ENTRY_TYPE.COMMISSION_RESERVE,
    COMMISSION_WALLET_ENTRY_TYPE.COMMISSION_RESERVE_RELEASE,
    COMMISSION_WALLET_ENTRY_TYPE.COMMISSION_SUBSIDY_CREDIT,
    COMMISSION_WALLET_ENTRY_TYPE.TOP_UP_REVERSAL,
    COMMISSION_WALLET_ENTRY_TYPE.ADMIN_CORRECTION,
    "",
    null,
  ]) {
    assertEquals(isDriverVisibleCommissionWalletEntryType(t), false, String(t));
  }
});

Deno.test("statement currency formatting", () => {
  assertEquals(formatPenceWithCurrency(1234, "GBP"), "£12.34");
  assertEquals(formatPenceWithCurrency(-505, "gbp"), "-£5.05");
  assertEquals(formatPenceWithCurrency(100, null), "1.00");
  assertEquals(formatPenceSigned(1234, "GBP"), "+£12.34");
  assertEquals(formatPenceSigned(-1234, "EUR"), "-€12.34");
});
