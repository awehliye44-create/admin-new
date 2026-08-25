/**
 * Demo edge entry — value import resolves; type-only import target absent from archive.
 */
import { helperValue } from "./helper.ts";
import type { MissingTypeRef } from "./missingTypeOnly.ts";

export function demoHandler(): { ok: boolean; type: MissingTypeRef | null } {
  return { ok: helperValue(), type: null };
}

if (import.meta.main) {
  Deno.serve(() => new Response(JSON.stringify(demoHandler())));
}
