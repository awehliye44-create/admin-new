/**
 * save-customer-push-token — raw APNs guard + unchanged ownership behaviour.
 *
 * Run:
 *   deno test --allow-read --allow-env supabase/functions/save-customer-push-token/handler.test.ts
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.57.2";
import { handleSaveCustomerPushToken } from "./handler.ts";

type Row = Record<string, unknown>;
type Tables = { customer_active_devices: Row[]; customer_push_tokens: Row[] };
type Op = { table: keyof Tables; op: string; payload?: Row };

const USER = "11111111-1111-1111-1111-111111111111";
const OTHER_USER = "22222222-2222-2222-2222-222222222222";
const DEVICE = "install-device-0001";
const OTHER_DEVICE = "install-device-0002";
const RAW_APNS = "a1b2c3d4".repeat(8);
const IOS_FCM = `dQw4w9WgXcQ:APA91b${"I".repeat(134)}`;
const ANDROID_FCM = `fGx7Kp2LmNo:APA91b${"A".repeat(134)}`;

function fakeSupabase(seed: Partial<Tables>, userId: string | null = USER) {
  const db: Tables = {
    customer_active_devices: (seed.customer_active_devices ?? []).map((r) => ({ ...r })),
    customer_push_tokens: (seed.customer_push_tokens ?? []).map((r) => ({ ...r })),
  };
  const ops: Op[] = [];

  function from(table: keyof Tables) {
    const filters: Array<["eq" | "neq", string, unknown]> = [];
    let op = "select";
    let payload: Row | undefined;
    let onConflict = "";

    const matches = () =>
      db[table].filter((r) =>
        filters.every(([kind, col, val]) => (kind === "eq" ? r[col] === val : r[col] !== val))
      );

    const exec = () => {
      ops.push({ table, op, payload });
      if (op === "upsert" && payload) {
        const idx = db[table].findIndex((r) => r[onConflict] === payload![onConflict]);
        if (idx >= 0) db[table][idx] = { ...db[table][idx], ...payload };
        else db[table].push({ ...payload });
      } else if (op === "update" && payload) {
        for (const r of matches()) Object.assign(r, payload);
      } else if (op === "delete") {
        const gone = new Set(matches());
        db[table] = db[table].filter((r) => !gone.has(r));
      }
      return Promise.resolve({ data: null, error: null });
    };

    const builder = {
      select() {
        op = "select";
        return builder;
      },
      eq(col: string, val: unknown) {
        filters.push(["eq", col, val]);
        return builder;
      },
      neq(col: string, val: unknown) {
        filters.push(["neq", col, val]);
        return builder;
      },
      maybeSingle() {
        ops.push({ table, op: "select" });
        return Promise.resolve({ data: matches()[0] ?? null, error: null });
      },
      upsert(row: Row, opts: { onConflict: string }) {
        op = "upsert";
        payload = row;
        onConflict = opts.onConflict;
        return exec();
      },
      update(row: Row) {
        op = "update";
        payload = row;
        return builder;
      },
      delete() {
        op = "delete";
        return builder;
      },
      then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
        return exec().then(resolve, reject);
      },
    };
    return builder;
  }

  const client = {
    auth: {
      getUser: (_jwt: string) =>
        Promise.resolve({ data: { user: userId ? { id: userId } : null }, error: null }),
    },
    from,
  } as unknown as SupabaseClient;

  return { client, db, ops };
}

function post(body: Row): Request {
  return new Request("https://example.supabase.co/functions/v1/save-customer-push-token", {
    method: "POST",
    headers: { Authorization: "Bearer test-jwt", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const activeDevice = (deviceId = DEVICE) => ({ user_id: USER, device_id: deviceId, platform: "ios" });
const tokenRow = (token: string, platform: string, userId = USER) => ({
  user_id: userId,
  app_type: "customer",
  platform,
  token,
});

Deno.test("A: a 64-hex raw APNs token is rejected with the structured 400 error", async () => {
  for (const [token, platform] of [
    [RAW_APNS, "ios"],
    [RAW_APNS.toUpperCase(), "ios"],
    [`  ${RAW_APNS}  `, "ios"],
    [RAW_APNS, "android"],
  ]) {
    const { client, ops } = fakeSupabase({ customer_active_devices: [activeDevice()] });
    const res = await handleSaveCustomerPushToken(
      post({ token, platform, device_id: DEVICE, claim: false }),
      () => client,
    );
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "RAW_APNS_TOKEN_REJECTED");
    assertEquals(typeof body.message, "string");
    assertEquals(ops, [], "rejected before any device or token read/write");
  }
});

Deno.test("B: a valid iOS FCM token is accepted and stored", async () => {
  const { client, db } = fakeSupabase({ customer_active_devices: [activeDevice()] });
  const res = await handleSaveCustomerPushToken(
    post({ token: IOS_FCM, platform: "ios", device_id: DEVICE, claim: false }),
    () => client,
  );
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { success: true, device_id: DEVICE });
  assertEquals(db.customer_push_tokens.length, 1);
  const row = db.customer_push_tokens[0];
  assertEquals([row.user_id, row.app_type, row.platform, row.token], [USER, "customer", "ios", IOS_FCM]);
});

Deno.test("C: a valid Android FCM token is accepted and stored", async () => {
  const { client, db } = fakeSupabase({
    customer_active_devices: [{ ...activeDevice(), platform: "android" }],
  });
  const res = await handleSaveCustomerPushToken(
    post({ token: ANDROID_FCM, platform: "android", device_id: DEVICE, claim: false }),
    () => client,
  );
  assertEquals(res.status, 200);
  assertEquals(db.customer_push_tokens.length, 1);
  const row = db.customer_push_tokens[0];
  assertEquals([row.user_id, row.platform, row.token], [USER, "android", ANDROID_FCM]);
});

Deno.test("D: sole-token replacement still wipes the user's other tokens only", async () => {
  const { client, db } = fakeSupabase({
    customer_active_devices: [activeDevice()],
    customer_push_tokens: [
      tokenRow(ANDROID_FCM, "android"),
      tokenRow(RAW_APNS, "ios"),
      tokenRow(`other:${"Z".repeat(140)}`, "android", OTHER_USER),
    ],
  });
  const res = await handleSaveCustomerPushToken(
    post({ token: IOS_FCM, platform: "ios", device_id: DEVICE, claim: false }),
    () => client,
  );
  assertEquals(res.status, 200);
  const mine = db.customer_push_tokens.filter((r) => r.user_id === USER).map((r) => r.token);
  assertEquals(mine, [IOS_FCM]);
  assertEquals(db.customer_push_tokens.filter((r) => r.user_id === OTHER_USER).length, 1);
});

Deno.test("D: a stale device without claim still gets DEVICE_REPLACED and writes no token", async () => {
  const { client, db, ops } = fakeSupabase({
    customer_active_devices: [activeDevice(OTHER_DEVICE)],
    customer_push_tokens: [tokenRow(ANDROID_FCM, "android")],
  });
  const res = await handleSaveCustomerPushToken(
    post({ token: IOS_FCM, platform: "ios", device_id: DEVICE, claim: false }),
    () => client,
  );
  assertEquals(res.status, 409);
  const body = await res.json();
  assertEquals(body.error, "DEVICE_REPLACED");
  assertEquals(body.active_device_id, OTHER_DEVICE);
  assertEquals(db.customer_push_tokens.map((r) => r.token), [ANDROID_FCM]);
  assert(ops.every((o) => o.table !== "customer_push_tokens"));
});

Deno.test("D: claim=true takes over the active device, and no active device claims on bind", async () => {
  const takeover = fakeSupabase({ customer_active_devices: [activeDevice(OTHER_DEVICE)] });
  const res1 = await handleSaveCustomerPushToken(
    post({ token: IOS_FCM, platform: "ios", device_id: DEVICE, claim: true }),
    () => takeover.client,
  );
  assertEquals(res1.status, 200);
  assertEquals(takeover.db.customer_active_devices[0].device_id, DEVICE);
  assertEquals(takeover.db.customer_push_tokens.map((r) => r.token), [IOS_FCM]);

  const fresh = fakeSupabase({});
  const res2 = await handleSaveCustomerPushToken(
    post({ token: ANDROID_FCM, platform: "android", device_id: DEVICE }),
    () => fresh.client,
  );
  assertEquals(res2.status, 200);
  assertEquals(fresh.db.customer_active_devices.map((r) => r.device_id), [DEVICE]);
  assertEquals(fresh.db.customer_push_tokens.map((r) => r.token), [ANDROID_FCM]);
});

Deno.test("E: a rejected APNs token is not inserted and stored tokens are left exactly as they were", async () => {
  const seed: Partial<Tables> = {
    customer_active_devices: [activeDevice()],
    customer_push_tokens: [
      tokenRow(IOS_FCM, "ios"),
      tokenRow("f".repeat(64), "ios"),
    ],
  };
  for (const claim of [false, true]) {
    const { client, db } = fakeSupabase(seed);
    const before = structuredClone(db);
    const res = await handleSaveCustomerPushToken(
      post({ token: RAW_APNS, platform: "ios", device_id: DEVICE, claim }),
      () => client,
    );
    assertEquals(res.status, 400);
    assertEquals(db.customer_push_tokens.some((r) => r.token === RAW_APNS), false);
    assertEquals(db, before, "no insert, no sibling wipe, historical rows not deleted");
  }
});

Deno.test("existing auth / validation responses are unchanged", async () => {
  const { client } = fakeSupabase({}, null);
  const unauth = await handleSaveCustomerPushToken(
    post({ token: IOS_FCM, platform: "ios", device_id: DEVICE }),
    () => client,
  );
  assertEquals(unauth.status, 401);

  const ok = fakeSupabase({});
  const missing = await handleSaveCustomerPushToken(post({ platform: "ios", device_id: DEVICE }), () => ok.client);
  assertEquals([missing.status, (await missing.json()).error], [400, "Missing token or platform"]);
  const badPlatform = await handleSaveCustomerPushToken(
    post({ token: IOS_FCM, platform: "web", device_id: DEVICE }),
    () => ok.client,
  );
  assertEquals([badPlatform.status, (await badPlatform.json()).error], [400, "Invalid platform"]);
  const noDevice = await handleSaveCustomerPushToken(post({ token: IOS_FCM, platform: "ios" }), () => ok.client);
  assertEquals([noDevice.status, (await noDevice.json()).error], [400, "device_id required"]);
});

Deno.test("entrypoint serves the handler unconditionally; guard precedes every DB access", async () => {
  const index = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assert(index.includes("serve((req) =>"));
  assert(index.includes("handleSaveCustomerPushToken(req"));
  assertEquals(index.includes("import.meta.main"), false);

  const handler = await Deno.readTextFile(new URL("./handler.ts", import.meta.url));
  assert(handler.includes('from "../_shared/customerNotificationPush.ts"'));
  const guard = handler.indexOf("isRawApnsDeviceToken(body.token)");
  assert(guard > 0);
  assert(guard < handler.indexOf('.from("customer_active_devices")'));
  assert(guard < handler.indexOf('.from("customer_push_tokens")'));
});
