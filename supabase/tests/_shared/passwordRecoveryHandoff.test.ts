import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  openRecoveryHandoff,
  passwordRecoveryBridgeUrl,
  passwordRecoveryHandoffLocation,
  recoveryHandoffSecret,
  sealRecoveryHandoff,
} from "../../functions/_shared/passwordRecoveryHandoff.ts";
import {
  DEFAULT_CUSTOMER_PASSWORD_RESET_REDIRECT,
  DEFAULT_DRIVER_PASSWORD_RESET_REDIRECT,
} from "../../functions/_shared/passwordRecoverySSOT.ts";
import { buildPasswordResetEmail } from "../../functions/_shared/passwordResetEmail.ts";

const SECRET = "test-service-role-key";
const ACCESS = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEiLCJhbXIiOlt7Im1ldGhvZCI6Im90cCJ9XX0.sig";
const REFRESH = "refresh-abc123";
const SESSION = { accessToken: ACCESS, refreshToken: REFRESH, tokenType: "bearer", expiresAt: 1_900_000_000 };
const NOW = 1_800_000_000;
const IOS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36";

Deno.test("sealed handoff round-trips and never exposes raw tokens", async () => {
  const sealed = await sealRecoveryHandoff({ app: "customer", session: SESSION, secret: SECRET, nowSeconds: NOW });
  assert(/^[A-Za-z0-9_-]+$/.test(sealed));
  assertEquals(sealed.includes(ACCESS), false);
  assertEquals(sealed.includes(REFRESH), false);
  assertEquals(sealed.includes("eyJ"), false);

  const opened = await openRecoveryHandoff({ token: sealed, app: "customer", secret: SECRET, nowSeconds: NOW + 60 });
  assertEquals(opened, { ok: true, session: SESSION });
});

Deno.test("handoff is bound to the app, the secret and its contents", async () => {
  const sealed = await sealRecoveryHandoff({ app: "customer", session: SESSION, secret: SECRET, nowSeconds: NOW });
  assertEquals(
    await openRecoveryHandoff({ token: sealed, app: "driver", secret: SECRET, nowSeconds: NOW }),
    { ok: false, reason: "invalid" },
  );
  assertEquals(
    await openRecoveryHandoff({ token: sealed, app: "customer", secret: "other", nowSeconds: NOW }),
    { ok: false, reason: "invalid" },
  );
  const flipped = sealed.slice(0, 20) + (sealed[20] === "A" ? "B" : "A") + sealed.slice(21);
  assertEquals(
    await openRecoveryHandoff({ token: flipped, app: "customer", secret: SECRET, nowSeconds: NOW }),
    { ok: false, reason: "invalid" },
  );
  assertEquals(
    await openRecoveryHandoff({ token: "not a token!", app: "customer", secret: SECRET, nowSeconds: NOW }),
    { ok: false, reason: "invalid" },
  );
  assertEquals(
    await openRecoveryHandoff({ token: sealed, app: "customer", secret: "", nowSeconds: NOW }),
    { ok: false, reason: "invalid" },
  );
});

Deno.test("handoff expires after its TTL (default 60 minutes)", async () => {
  const sealed = await sealRecoveryHandoff({ app: "driver", session: SESSION, secret: SECRET, nowSeconds: NOW });
  assertEquals(
    (await openRecoveryHandoff({ token: sealed, app: "driver", secret: SECRET, nowSeconds: NOW + 3599 })).ok,
    true,
  );
  assertEquals(
    await openRecoveryHandoff({ token: sealed, app: "driver", secret: SECRET, nowSeconds: NOW + 3600 }),
    { ok: false, reason: "expired" },
  );
});

Deno.test("seal refuses a missing secret or incomplete session", async () => {
  await assertRejects(() => sealRecoveryHandoff({ app: "customer", session: SESSION, secret: "" }));
  await assertRejects(() =>
    sealRecoveryHandoff({ app: "customer", session: { accessToken: ACCESS, refreshToken: " " }, secret: SECRET })
  );
});

Deno.test("recoveryHandoffSecret prefers a dedicated secret, else the service role key", () => {
  assertEquals(recoveryHandoffSecret({ SUPABASE_SERVICE_ROLE_KEY: "srk" }), "srk");
  assertEquals(
    recoveryHandoffSecret({ PASSWORD_RECOVERY_HANDOFF_SECRET: "dedicated", SUPABASE_SERVICE_ROLE_KEY: "srk" }),
    "dedicated",
  );
  assertEquals(recoveryHandoffSecret({}), "");
});

Deno.test("bridge URL is https on the project functions host", () => {
  const url = passwordRecoveryBridgeUrl("https://thazislrdkjpvvghtvzo.supabase.co/", "customer", "abc_-123");
  assertEquals(
    url,
    "https://thazislrdkjpvvghtvzo.supabase.co/functions/v1/password-recovery-link?app=customer&h=abc_-123",
  );
});

Deno.test("iOS hand-off opens the Customer app reset route with the session", () => {
  const loc = passwordRecoveryHandoffLocation({
    app: "customer",
    nativeRedirect: DEFAULT_CUSTOMER_PASSWORD_RESET_REDIRECT,
    session: SESSION,
    userAgent: IOS_UA,
  });
  assert(loc.startsWith("onecab-customer://auth/reset-password#"));
  const params = new URLSearchParams(loc.split("#")[1]);
  assertEquals(params.get("access_token"), ACCESS);
  assertEquals(params.get("refresh_token"), REFRESH);
  assertEquals(params.get("type"), "recovery");
});

Deno.test("Android hand-off uses intent:// with the real package and tokens in the query", () => {
  const customer = passwordRecoveryHandoffLocation({
    app: "customer",
    nativeRedirect: DEFAULT_CUSTOMER_PASSWORD_RESET_REDIRECT,
    session: SESSION,
    userAgent: ANDROID_UA,
  });
  assert(customer.startsWith("intent://auth/reset-password?"));
  assert(customer.endsWith("#Intent;scheme=onecab-customer;package=com.onecab.customer.app;end"));
  const query = new URLSearchParams(customer.slice(customer.indexOf("?") + 1, customer.indexOf("#")));
  assertEquals(query.get("access_token"), ACCESS);
  assertEquals(query.get("refresh_token"), REFRESH);
  assertEquals(query.get("type"), "recovery");

  const driver = passwordRecoveryHandoffLocation({
    app: "driver",
    nativeRedirect: DEFAULT_DRIVER_PASSWORD_RESET_REDIRECT,
    session: SESSION,
    userAgent: ANDROID_UA,
  });
  assert(driver.startsWith("intent://reset-password?"));
  assert(driver.endsWith("#Intent;scheme=onecab-driver;package=com.onecab.driver.app;end"));
});

Deno.test("invalid or expired link hands off an otp_expired error without tokens", () => {
  for (const userAgent of [IOS_UA, ANDROID_UA]) {
    const loc = passwordRecoveryHandoffLocation({
      app: "customer",
      nativeRedirect: DEFAULT_CUSTOMER_PASSWORD_RESET_REDIRECT,
      session: null,
      userAgent,
    });
    assertEquals(loc.includes("access_token"), false);
    assertEquals(loc.includes("refresh_token"), false);
    assert(loc.includes("error_code=otp_expired"));
    assert(loc.includes("type=recovery"));
  }
});

Deno.test("hand-off refuses a redirect for the other app's scheme", () => {
  let threw = false;
  try {
    passwordRecoveryHandoffLocation({
      app: "customer",
      nativeRedirect: "https://evil.example/reset",
      session: SESSION,
      userAgent: IOS_UA,
    });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("password reset email rejects native deep links and renders an https button", () => {
  let threw = false;
  try {
    buildPasswordResetEmail({ recoveryUrl: "onecab-customer://auth/reset-password#access_token=x", app: "customer" });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);

  const bridge = passwordRecoveryBridgeUrl("https://thazislrdkjpvvghtvzo.supabase.co", "customer", "sealed123");
  const rendered = buildPasswordResetEmail({ recoveryUrl: bridge, app: "customer" });
  assert(rendered.html.includes(`href="${bridge.replace(/&/g, "&amp;")}"`));
  assertEquals(rendered.html.includes("onecab-customer://"), false);
  assert(rendered.text.includes(bridge));
});

Deno.test("password-recovery-link bridge is public, read-only and never logs tokens", () => {
  const src = Deno.readTextFileSync(
    new URL("../../functions/password-recovery-link/index.ts", import.meta.url),
  );
  assert(src.includes("openRecoveryHandoff"));
  assert(src.includes("passwordRecoveryHandoffLocation"));
  assertEquals(/console\.[a-z]+\([^)]*(session|handoff|accessToken|refreshToken)\b/.test(src), false);
  assertEquals(src.includes("auth.admin"), false);
  assertEquals(src.includes("/auth/v1/verify"), false);

  const config = Deno.readTextFileSync(new URL("../../config.toml", import.meta.url));
  assert(/\[functions\.password-recovery-link\]\s*\nverify_jwt = false/.test(config));
});
