const out = process.env.STEP82A5_CAPTURE_OUT;
if (!out) throw new Error("STEP82A5_CAPTURE_OUT required");

const orig = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const res = await orig(input, init);
  const url = typeof input === "string" ? input : input.url;
  if (url.includes("/functions/") && url.endsWith("/body") && res.ok) {
    const ab = await res.arrayBuffer();
    await Bun.write(out, new Uint8Array(ab));
    process.stderr.write(`[capture] wrote ${ab.byteLength} bytes to ${out}\n`);
    return new Response(ab, { status: res.status, headers: res.headers });
  }
  return res;
};
