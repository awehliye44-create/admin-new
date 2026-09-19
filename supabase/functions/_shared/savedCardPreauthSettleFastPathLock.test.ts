/**
 * Lock: Edge saved-card settle may wait for AUTHORISED without ACS, but must
 * never suppress SCA when an ACS URL is present.
 */
import {
  SAVED_CARD_PREAUTH_SETTLE_MAX_MS,
  SAVED_CARD_PREAUTH_SETTLE_POLL_MS,
} from "./revolutPreauth.ts";

const src = await Deno.readTextFile(
  new URL("./revolutPreauth.ts", import.meta.url),
);

Deno.test("saved-card Edge settle budget is Bolt-class (≥6s, ≤10s)", () => {
  if (SAVED_CARD_PREAUTH_SETTLE_MAX_MS < 6_000 || SAVED_CARD_PREAUTH_SETTLE_MAX_MS > 10_000) {
    throw new Error(`unexpected settle max ${SAVED_CARD_PREAUTH_SETTLE_MAX_MS}`);
  }
  if (SAVED_CARD_PREAUTH_SETTLE_POLL_MS < 100 || SAVED_CARD_PREAUTH_SETTLE_POLL_MS > 500) {
    throw new Error(`unexpected settle poll ${SAVED_CARD_PREAUTH_SETTLE_POLL_MS}`);
  }
});

Deno.test("ACS URL still short-circuits to requires_3ds (SCA preserved)", () => {
  if (!src.includes('return { kind: "requires_3ds"')) {
    throw new Error("requires_3ds return missing");
  }
  if (!src.includes("authentication_challenge?.acs_url")) {
    throw new Error("ACS URL check missing");
  }
  // Must not treat challenge-without-ACS as terminal requires_3ds-only exit before poll budget.
  if (!src.includes("Challenge without ACS")) {
    throw new Error("no-ACS continue path comment/marker missing");
  }
});

Deno.test("AUTHORISED still requires order AUTHORISED (financial gate)", () => {
  if (!src.includes("isRevolutAuthorisedState(orderState)")) {
    throw new Error("order AUTHORISED gate missing");
  }
});
