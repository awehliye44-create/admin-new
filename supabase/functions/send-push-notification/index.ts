import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "npm:@supabase/supabase-js@2.90.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface SendNotificationRequest {
  userId: string;
  title: string;
  body: string;
  url?: string;
  tripId?: string;
  tag?: string;
  requireInteraction?: boolean;
}

interface PushSubscription {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

// Helper functions for Web Push
function urlBase64ToBuffer(base64: string): ArrayBuffer {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(b64);
  const buffer = new ArrayBuffer(rawData.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < rawData.length; i++) {
    view[i] = rawData.charCodeAt(i);
  }
  return buffer;
}

function bufferToBase64Url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function concatBuffers(...buffers: ArrayBuffer[]): ArrayBuffer {
  const totalLength = buffers.reduce((sum, buf) => sum + buf.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const buf of buffers) {
    result.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  }
  return result.buffer;
}

async function generateVapidJwt(
  audience: string,
  subject: string,
  publicKey: string,
  privateKey: string
): Promise<string> {
  const url = new URL(audience);
  const aud = `${url.protocol}//${url.host}`;
  
  const header = { typ: "JWT", alg: "ES256" };
  const payload = {
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: subject,
  };

  const headerB64 = bufferToBase64Url(new TextEncoder().encode(JSON.stringify(header)).buffer);
  const payloadB64 = bufferToBase64Url(new TextEncoder().encode(JSON.stringify(payload)).buffer);
  const unsignedToken = `${headerB64}.${payloadB64}`;

  // Import the private key (assuming it's in raw format)
  const keyData = urlBase64ToBuffer(privateKey);
  
  try {
    const cryptoKey = await crypto.subtle.importKey(
      "pkcs8",
      keyData,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"]
    );

    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      cryptoKey,
      new TextEncoder().encode(unsignedToken)
    );

    const signatureB64 = bufferToBase64Url(signature);
    return `${unsignedToken}.${signatureB64}`;
  } catch (e) {
    console.error("Error generating JWT:", e);
    throw e;
  }
}

async function sendWebPush(
  subscription: PushSubscription,
  payload: string,
  vapidPublicKey: string,
  vapidPrivateKey: string
): Promise<void> {
  // For now, we'll use a simplified approach that works with FCM/Mozilla push services
  // Generate VAPID authorization
  const jwt = await generateVapidJwt(
    subscription.endpoint,
    "mailto:support@example.com",
    vapidPublicKey,
    vapidPrivateKey
  );

  // Generate encryption keys
  const localKeyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"]
  );

  const localPublicKeyRaw = await crypto.subtle.exportKey("raw", localKeyPair.publicKey);
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // Import subscriber's public key
  const subscriberKeyBuffer = urlBase64ToBuffer(subscription.keys.p256dh);
  const subscriberKey = await crypto.subtle.importKey(
    "raw",
    subscriberKeyBuffer,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    []
  );

  // Derive shared secret
  const sharedSecret = await crypto.subtle.deriveBits(
    { name: "ECDH", public: subscriberKey },
    localKeyPair.privateKey,
    256
  );

  // Derive content encryption key using HKDF
  const authSecret = urlBase64ToBuffer(subscription.keys.auth);
  
  // Create IKM
  const ikmInfo = new TextEncoder().encode("WebPush: info\0");
  const ikmInfoBuffer = concatBuffers(
    ikmInfo.buffer,
    subscriberKeyBuffer,
    localPublicKeyRaw
  );

  const ikmKey = await crypto.subtle.importKey(
    "raw",
    sharedSecret,
    { name: "HKDF" },
    false,
    ["deriveBits"]
  );

  const ikm = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: authSecret,
      info: new Uint8Array(ikmInfoBuffer),
    },
    ikmKey,
    256
  );

  // Derive CEK and nonce
  const prkKey = await crypto.subtle.importKey(
    "raw",
    ikm,
    { name: "HKDF" },
    false,
    ["deriveBits"]
  );

  const cekInfo = new TextEncoder().encode("Content-Encoding: aes128gcm\0");
  const cek = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt.buffer,
      info: cekInfo,
    },
    prkKey,
    128
  );

  const nonceInfo = new TextEncoder().encode("Content-Encoding: nonce\0");
  const nonce = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: salt.buffer,
      info: nonceInfo,
    },
    prkKey,
    96
  );

  // Encrypt payload
  const aesKey = await crypto.subtle.importKey(
    "raw",
    cek,
    { name: "AES-GCM" },
    false,
    ["encrypt"]
  );

  const payloadBytes = new TextEncoder().encode(payload);
  const paddedPayload = new Uint8Array(payloadBytes.length + 2);
  paddedPayload.set(payloadBytes);
  paddedPayload[payloadBytes.length] = 2; // Delimiter

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: new Uint8Array(nonce) },
    aesKey,
    paddedPayload
  );

  // Build aes128gcm header
  const recordSize = new ArrayBuffer(4);
  new DataView(recordSize).setUint32(0, 4096, false);

  const keyIdLen = new Uint8Array([65]); // P-256 public key is 65 bytes
  const header = concatBuffers(
    salt.buffer,
    recordSize,
    keyIdLen.buffer,
    localPublicKeyRaw,
    encrypted
  );

  // Send the push message
  const response = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      "TTL": "86400",
      "Authorization": `vapid t=${jwt}, k=${vapidPublicKey}`,
    },
    body: header,
  });

  if (!response.ok) {
    const error = new Error(`Push failed: ${response.status} ${response.statusText}`);
    (error as unknown as { statusCode: number }).statusCode = response.status;
    throw error;
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const vapidPublicKey = Deno.env.get("VAPID_PUBLIC_KEY")!;
    const vapidPrivateKey = Deno.env.get("VAPID_PRIVATE_KEY")!;

    // --- Authentication: only allow service-role or admin callers ---
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const token = authHeader.replace("Bearer ", "");

    // If the token is the service role key, allow (server-to-server call)
    const isServiceRole = token === supabaseServiceKey;

    if (!isServiceRole) {
      // Validate as a user JWT and check for admin role
      const supabaseAuth = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: claims, error: claimsError } = await supabaseAuth.auth.getUser(token);
      if (claimsError || !claims?.user) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      // Only admins can call this directly (non-service-role)
      const adminCheck = createClient(supabaseUrl, supabaseServiceKey);
      const { data: roleData } = await adminCheck
        .from("user_roles")
        .select("role")
        .eq("user_id", claims.user.id)
        .eq("role", "admin")
        .maybeSingle();
      if (!roleData) {
        return new Response(JSON.stringify({ error: "Forbidden" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
    }
    // --- End authentication ---

    if (!vapidPublicKey || !vapidPrivateKey) {
      console.error("VAPID keys not configured");
      return new Response(JSON.stringify({ error: "Push notifications not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const body: SendNotificationRequest = await req.json();

    if (!body.userId || !body.title) {
      return new Response(JSON.stringify({ error: "Missing required fields" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get user's push subscriptions
    const { data: subscriptions, error: subError } = await supabase
      .from("push_subscriptions")
      .select("endpoint, keys")
      .eq("user_id", body.userId);

    if (subError) {
      console.error("Error fetching subscriptions:", subError);
      return new Response(JSON.stringify({ error: "Failed to fetch subscriptions" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!subscriptions || subscriptions.length === 0) {
      console.log("No push subscriptions found for user:", body.userId);
      return new Response(JSON.stringify({ success: true, sent: 0 }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const payload = JSON.stringify({
      title: body.title,
      body: body.body,
      url: body.url || "/ride-tracking",
      tripId: body.tripId,
      tag: body.tag || "ride-update",
      requireInteraction: body.requireInteraction ?? true,
    });

    let sent = 0;
    let failed = 0;

    for (const sub of subscriptions) {
      try {
        const pushSubscription: PushSubscription = {
          endpoint: sub.endpoint,
          keys: sub.keys as { p256dh: string; auth: string },
        };

        await sendWebPush(pushSubscription, payload, vapidPublicKey, vapidPrivateKey);
        sent++;
        console.log("Push notification sent to:", sub.endpoint.substring(0, 50));
      } catch (err: unknown) {
        const error = err as { statusCode?: number; message?: string };
        console.error("Error sending push:", error.message || error);
        failed++;

        // Remove invalid subscriptions
        if (error.statusCode === 410 || error.statusCode === 404) {
          await supabase
            .from("push_subscriptions")
            .delete()
            .eq("endpoint", sub.endpoint);
          console.log("Removed expired subscription:", sub.endpoint.substring(0, 50));
        }
      }
    }

    console.log(`Push notifications: ${sent} sent, ${failed} failed for user ${body.userId}`);

    return new Response(JSON.stringify({ success: true, sent, failed }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Error in send-push-notification:", error);
    return new Response(JSON.stringify({ error: "Internal server error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
