function hexFromBytes(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let hex = "";
  for (let i = 0; i < view.length; i++) hex += view[i].toString(16).padStart(2, "0");
  return hex;
}
function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  }
  const verifyToken = Deno.env.get("WHATSAPP_WEBHOOK_VERIFY_TOKEN")?.trim() ?? "";
  const phoneNumberId = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID")?.trim() ?? "";
  if (!verifyToken || !phoneNumberId) {
    return Response.json({ error: "whatsapp_signing_unavailable" }, { status: 503 });
  }
  let waId = "447491376424";
  try {
    const body = await req.json();
    if (typeof body?.wa_id === "string" && /^\d{10,15}$/.test(body.wa_id)) waId = body.wa_id;
  } catch {
    /* default */
  }
  const exp = Math.floor(Date.now() / 1000) + 7200;
  const payload = `book:${waId}::${exp}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`${verifyToken}:${phoneNumberId}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = hexFromBytes(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  const token = `${base64UrlEncode(payload)}.${sig}`;
  return Response.json({
    wa_id: waId,
    url: `https://onecab.net/whatsapp-booking?wa=${encodeURIComponent(token)}`,
    token,
  });
});
