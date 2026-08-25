#!/usr/bin/env node
/**
 * HTTPS CONNECT proxy capturing function /body responses from Supabase Management API.
 * Usage:
 *   STEP82A5_CAPTURE_OUT=/path/raw.bin node scripts/step82a5-capture-function-body-proxy.mjs &
 *   HTTP_PROXY=http://127.0.0.1:8765 HTTPS_PROXY=http://127.0.0.1:8765 \
 *     supabase functions download SLUG --project-ref REF --use-api --workdir /tmp/x
 */
import net from "node:net";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const listenPort = Number(process.env.STEP82A5_PROXY_PORT ?? "8765");
const outFile = process.env.STEP82A5_CAPTURE_OUT;
if (!outFile) {
  console.error("Set STEP82A5_CAPTURE_OUT");
  process.exit(1);
}
mkdirSync(dirname(outFile), { recursive: true });

function captureIfBodyRequest(connectTarget, data) {
  if (!connectTarget.includes("api.supabase.com")) return;
  const text = data.toString("latin1");
  const m = text.match(/GET \/v1\/projects\/[^ ]+\/functions\/[^ /]+\/body/);
  if (!m) return;
  // Response body follows HTTP headers in the same TCP stream from server; capture full server->client.
  return true;
}

const server = net.createServer((clientSocket) => {
  let headerBuf = Buffer.alloc(0);
  let serverSocket = null;
  let connectTarget = "";
  let capturing = false;
  const serverChunks = [];

  clientSocket.on("data", (chunk) => {
    if (!serverSocket) {
      headerBuf = Buffer.concat([headerBuf, chunk]);
      const headerEnd = headerBuf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;

      const headerText = headerBuf.slice(0, headerEnd).toString();
      const rest = headerBuf.slice(headerEnd + 4);
      const line = headerText.split("\r\n")[0] ?? "";
      const connectMatch = line.match(/^CONNECT ([^:]+):(\d+)/i);
      if (!connectMatch) {
        clientSocket.destroy();
        return;
      }
      connectTarget = connectMatch[1];
      const port = Number(connectMatch[2]);
      capturing = connectTarget.includes("api.supabase.com");

      serverSocket = net.connect(port, connectTarget, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (rest.length) serverSocket.write(rest);
      });

      serverSocket.on("data", (serverChunk) => {
        if (capturing) serverChunks.push(Buffer.from(serverChunk));
        clientSocket.write(serverChunk);
      });
      serverSocket.on("end", () => clientSocket.end());
      serverSocket.on("error", () => clientSocket.destroy());
      return;
    }
    serverSocket.write(chunk);
  });

  clientSocket.on("end", () => {
    if (serverSocket && !serverSocket.destroyed) serverSocket.end();
  });
  clientSocket.on("error", () => {
    if (serverSocket) serverSocket.destroy();
  });
  clientSocket.on("close", () => {
    if (!capturing || serverChunks.length === 0) return;
    const raw = Buffer.concat(serverChunks);
    const text = raw.toString("latin1");
    const idx = text.search(/GET \/v1\/projects\/[^ ]+\/functions\/[^ /]+\/body/);
    if (idx === -1) return;
    const httpStart = raw.indexOf(Buffer.from("HTTP/1.1"));
    if (httpStart === -1) return;
    const headerEnd = raw.indexOf("\r\n\r\n", httpStart);
    if (headerEnd === -1) return;
    const body = raw.slice(headerEnd + 4);
    writeFileSync(outFile, body);
    process.stderr.write(`[proxy] captured response body ${body.length} bytes -> ${outFile}\n`);
  });
});

server.listen(listenPort, "127.0.0.1", () => {
  process.stderr.write(`[proxy] CONNECT proxy on 127.0.0.1:${listenPort}\n`);
});
