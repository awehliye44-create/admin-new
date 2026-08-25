#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run
/**
 * Safe Supabase function /body archive extractor.
 * Branches on HTTP Content-Type and/or magic bytes.
 */
import { parseArgs } from "https://deno.land/std@0.224.0/cli/parse_args.ts";
import { dirname, join, normalize, resolve } from "https://deno.land/std@0.224.0/path/mod.ts";

export type ArchiveFormat = "multipart" | "zip" | "gzip" | "tar" | "json_error" | "unknown";

export type ExtractResult = {
  format: ArchiveFormat;
  boundary?: string;
  paths_listed: string[];
  files_written: number;
  files: Array<{ archive_path: string; out_path: string; sha256: string; bytes: number }>;
  archive_sha256: string;
  extract_root: string;
  error?: { status?: number; code?: string; message: string };
};

export function parseContentTypeHeader(raw: string): { mediaType: string; boundary?: string } {
  const semi = raw.indexOf(";");
  const mediaType = (semi === -1 ? raw : raw.slice(0, semi)).trim().toLowerCase();
  let boundary: string | undefined;
  const bMatch = raw.match(/boundary=([^;\r\n]+)/i);
  if (bMatch) boundary = bMatch[1].trim().replace(/^"|"$/g, "");
  return { mediaType, boundary };
}

export function readResponseContentType(headersText: string): string | undefined {
  for (const line of headersText.split(/\r?\n/)) {
    if (line.toLowerCase().startsWith("content-type:")) {
      return line.slice("content-type:".length).trim();
    }
  }
  return undefined;
}

export function magicFormat(data: Uint8Array): ArchiveFormat | null {
  if (data.length >= 2 && data[0] === 0x50 && data[1] === 0x4b) return "zip";
  if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) return "gzip";
  if (data.length >= 2 && data[0] === 0x2d && data[1] === 0x2d) return "multipart";
  const head = new TextDecoder().decode(data.slice(0, 512)).trimStart();
  if (head.startsWith("{") || head.startsWith("[")) return "json_error";
  return null;
}

export function detectFormat(data: Uint8Array, contentType?: string): ArchiveFormat {
  const ct = contentType ? parseContentTypeHeader(contentType) : undefined;
  if (ct?.mediaType.startsWith("multipart/")) return "multipart";
  if (ct?.mediaType === "application/zip" || ct?.mediaType === "application/x-zip-compressed") return "zip";
  if (ct?.mediaType === "application/gzip" || ct?.mediaType === "application/x-gzip") return "gzip";
  if (ct?.mediaType === "application/json" || ct?.mediaType === "text/json") return "json_error";
  if (ct?.mediaType === "application/octet-stream") return magicFormat(data) ?? "unknown";
  return magicFormat(data) ?? "unknown";
}

export function boundaryFromBodyStart(data: Uint8Array): string | undefined {
  const line = new TextDecoder().decode(data.slice(0, 256)).split(/\r?\n/, 1)[0];
  if (!line.startsWith("--")) return undefined;
  return line.replace(/^--+/, "").trim();
}

export function resolveMultipartBoundary(data: Uint8Array, contentType?: string): string {
  const ct = contentType ? parseContentTypeHeader(contentType) : undefined;
  if (ct?.boundary) return ct.boundary;
  const fromBody = boundaryFromBodyStart(data);
  if (fromBody) return fromBody;
  throw new Error("No multipart boundary in Content-Type header or body delimiter");
}

export function isSafeRelative(p: string): boolean {
  if (!p || p.startsWith("/") || p.includes("\0")) return false;
  const n = normalize(p);
  if (n.startsWith("..") || n.includes("/../") || n === "..") return false;
  return true;
}

export function mapArchivePath(archivePathRel: string): string {
  let destRel = archivePathRel;
  if (destRel.startsWith("source/")) destRel = destRel.slice("source/".length);
  return destRel;
}

function indexOfBytes(hay: Uint8Array, needle: Uint8Array, from: number): number {
  outer: for (let i = from; i <= hay.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (hay[i + j] !== needle[j]) continue outer;
    }
    return i;
  }
  return -1;
}

export function splitMultipart(
  data: Uint8Array,
  boundary: string,
): Array<{ headers: string; body: Uint8Array }> {
  const delim = new TextEncoder().encode(`--${boundary}`);
  const parts: Array<{ headers: string; body: Uint8Array }> = [];
  let i = 0;
  while (i < data.length) {
    const start = indexOfBytes(data, delim, i);
    if (start < 0) break;
    i = start + delim.length;
    if (data[i] === 0x2d && data[i + 1] === 0x2d) break;
    if (data[i] === 0x0d) i += 2;
    else if (data[i] === 0x0a) i += 1;
    const next = indexOfBytes(data, delim, i);
    const chunk = data.slice(i, next < 0 ? data.length : next);
    const headerEnd = indexOfBytes(chunk, new TextEncoder().encode("\r\n\r\n"), 0);
    if (headerEnd < 0) continue;
    const headers = new TextDecoder().decode(chunk.slice(0, headerEnd));
    let body = chunk.slice(headerEnd + 4);
    if (body.length >= 2 && body[body.length - 2] === 0x0d && body[body.length - 1] === 0x0a) {
      body = body.slice(0, -2);
    }
    parts.push({ headers, body });
    i = next < 0 ? data.length : next;
  }
  return parts;
}

function filenameFromPartHeaders(headers: string): string | null {
  const fnMatch = headers.match(/filename\*=(?:UTF-8''|utf-8'')?([^;\r\n]+)/i)
    ?? headers.match(/filename="?([^";\r\n]+)"?/i);
  if (!fnMatch) return null;
  return decodeURIComponent(fnMatch[1].trim());
}

export function parseJsonError(data: Uint8Array): { status?: number; code?: string; message: string } {
  try {
    const obj = JSON.parse(new TextDecoder().decode(data));
    return {
      status: typeof obj.status === "number" ? obj.status : undefined,
      code: typeof obj.code === "string" ? obj.code : typeof obj.error === "string" ? obj.error : undefined,
      message: typeof obj.message === "string"
        ? obj.message
        : typeof obj.error?.message === "string"
        ? obj.error.message
        : typeof obj.msg === "string"
        ? obj.msg
        : "API returned JSON error body",
    };
  } catch {
    return { message: "API returned non-archive JSON/text body" };
  }
}

async function sha256(data: Uint8Array): Promise<string> {
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  const hash = await globalThis.crypto.subtle.digest("SHA-256", copy);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function writeRegularFile(outRoot: string, outPath: string, body: Uint8Array) {
  if (!outPath.startsWith(outRoot + "/") && outPath !== outRoot) {
    throw new Error(`REJECT escapes out root: ${outPath}`);
  }
  await Deno.mkdir(dirname(outPath), { recursive: true });
  await Deno.writeFile(outPath, body);
  const st = await Deno.lstat(outPath);
  if (!st.isFile) throw new Error(`REJECT non-regular file: ${outPath}`);
}

export async function extractArchive(
  data: Uint8Array,
  outRoot: string,
  opts: { contentType?: string; inspectOnly?: boolean } = {},
): Promise<ExtractResult> {
  const format = detectFormat(data, opts.contentType);
  const archiveSha = await sha256(data);

  if (format === "json_error") {
    return {
      format,
      paths_listed: [],
      files_written: 0,
      files: [],
      archive_sha256: archiveSha,
      extract_root: outRoot,
      error: parseJsonError(data),
    };
  }

  if (format === "multipart") {
    const boundary = resolveMultipartBoundary(data, opts.contentType);
    const parts = splitMultipart(data, boundary);
    const pathsListed: string[] = [];
    const files: ExtractResult["files"] = [];

    for (const part of parts) {
      const archivePathRel = filenameFromPartHeaders(part.headers);
      if (!archivePathRel) continue;
      pathsListed.push(archivePathRel);
      if (!isSafeRelative(archivePathRel)) throw new Error(`REJECT archive path: ${archivePathRel}`);
      const outPath = resolve(join(outRoot, mapArchivePath(archivePathRel)));
      if (!outPath.startsWith(outRoot + "/") && outPath !== outRoot) {
        throw new Error(`REJECT escapes out root: ${archivePathRel}`);
      }
    }

    if (!opts.inspectOnly) {
      for (const part of parts) {
        const archivePathRel = filenameFromPartHeaders(part.headers);
        if (!archivePathRel || !isSafeRelative(archivePathRel)) continue;
        const outPath = resolve(join(outRoot, mapArchivePath(archivePathRel)));
        await writeRegularFile(outRoot, outPath, part.body);
        files.push({
          archive_path: archivePathRel,
          out_path: outPath,
          sha256: await sha256(part.body),
          bytes: part.body.byteLength,
        });
      }
    }

    return {
      format: "multipart",
      boundary,
      paths_listed: pathsListed,
      files_written: files.length,
      files,
      archive_sha256: archiveSha,
      extract_root: outRoot,
    };
  }

  if (format === "zip") {
    const tmp = await Deno.makeTempFile({ prefix: "step82a5-", suffix: ".zip" });
    try {
      await Deno.writeFile(tmp, data);
      const listOut = await new Deno.Command("unzip", { args: ["-Z1", tmp], stdout: "piped" }).output();
      if (listOut.code !== 0) throw new Error("Invalid ZIP archive");
      const pathsListed = new TextDecoder().decode(listOut.stdout).split("\n").filter((p) => p && !p.endsWith("/"));
      for (const p of pathsListed) {
        if (!isSafeRelative(p)) throw new Error(`REJECT archive path: ${p}`);
      }
      const files: ExtractResult["files"] = [];
      if (!opts.inspectOnly) {
        for (const archivePathRel of pathsListed) {
          const outPath = resolve(join(outRoot, mapArchivePath(archivePathRel)));
          const proc = await new Deno.Command("unzip", {
            args: ["-p", tmp, archivePathRel],
            stdout: "piped",
            stderr: "piped",
          }).output();
          if (proc.code !== 0) throw new Error(`ZIP extract failed for ${archivePathRel}`);
          await writeRegularFile(outRoot, outPath, proc.stdout);
          files.push({
            archive_path: archivePathRel,
            out_path: outPath,
            sha256: await sha256(proc.stdout),
            bytes: proc.stdout.byteLength,
          });
        }
      }
      return {
        format: "zip",
        paths_listed: pathsListed,
        files_written: files.length,
        files,
        archive_sha256: archiveSha,
        extract_root: outRoot,
      };
    } finally {
      await Deno.remove(tmp);
    }
  }

  if (format === "gzip") {
    const tmp = await Deno.makeTempFile({ prefix: "step82a5-", suffix: ".tar.gz" });
    try {
      await Deno.writeFile(tmp, data);
      const listOut = await new Deno.Command("tar", { args: ["-tzf", tmp], stdout: "piped" }).output();
      if (listOut.code !== 0) throw new Error("Invalid gzip/tar archive");
      const pathsListed = new TextDecoder().decode(listOut.stdout).split("\n").filter((p) => p && !p.endsWith("/"));
      for (const p of pathsListed) {
        if (!isSafeRelative(p)) throw new Error(`REJECT archive path: ${p}`);
      }
      const files: ExtractResult["files"] = [];
      if (!opts.inspectOnly) {
        for (const archivePathRel of pathsListed) {
          const outPath = resolve(join(outRoot, mapArchivePath(archivePathRel)));
          const proc = await new Deno.Command("tar", {
            args: ["-xOzf", tmp, archivePathRel],
            stdout: "piped",
            stderr: "piped",
          }).output();
          if (proc.code !== 0) throw new Error(`gzip/tar extract failed for ${archivePathRel}`);
          await writeRegularFile(outRoot, outPath, proc.stdout);
          files.push({
            archive_path: archivePathRel,
            out_path: outPath,
            sha256: await sha256(proc.stdout),
            bytes: proc.stdout.byteLength,
          });
        }
      }
      return {
        format: "gzip",
        paths_listed: pathsListed,
        files_written: files.length,
        files,
        archive_sha256: archiveSha,
        extract_root: outRoot,
      };
    } finally {
      await Deno.remove(tmp);
    }
  }

  throw new Error(`Unsupported or unknown archive format (${format})`);
}

// CLI entrypoint
if (import.meta.main) {
  const args = parseArgs(Deno.args, {
    string: ["archive", "out", "slug", "content-type", "response-headers"],
    boolean: ["inspect-only"],
  });

  const archivePath = resolve(String(args.archive));
  const outRoot = resolve(String(args.out));
  const slug = String(args.slug ?? "");
  const inspectOnly = Boolean(args["inspect-only"]);
  let contentType = args["content-type"] ? String(args["content-type"]) : undefined;
  if (!contentType && args["response-headers"]) {
    contentType = readResponseContentType(await Deno.readTextFile(resolve(String(args["response-headers"]))));
  }

  await Deno.mkdir(outRoot, { recursive: true });
  const bytes = await Deno.readFile(archivePath);
  const result = await extractArchive(bytes, outRoot, { contentType, inspectOnly });

  if (result.format === "json_error") {
    console.log(JSON.stringify({ slug, ...result }, null, 2));
    Deno.exit(1);
  }

  console.log(JSON.stringify({ slug, inspect: inspectOnly, ...result }, null, 2));
  if (!inspectOnly && result.files_written === 0) Deno.exit(1);
}
