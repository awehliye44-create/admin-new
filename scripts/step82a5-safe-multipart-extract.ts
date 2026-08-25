#!/usr/bin/env -S deno run --allow-read --allow-write --allow-run
/** @deprecated Use step82a5-safe-archive-extract.ts */
import { parseArgs } from "https://deno.land/std@0.224.0/cli/parse_args.ts";
import { resolve } from "https://deno.land/std@0.224.0/path/mod.ts";

const args = parseArgs(Deno.args, {
  string: ["archive", "out", "slug", "content-type", "response-headers"],
  boolean: ["inspect-only"],
});

const cmd = new Deno.Command(Deno.execPath(), {
  args: [
    "run",
    "--allow-read",
    "--allow-write",
    "--allow-run",
    resolve(new URL("./step82a5-safe-archive-extract.ts", import.meta.url)),
    "--archive", resolve(String(args.archive)),
    "--out", resolve(String(args.out)),
    ...(args.slug ? ["--slug", String(args.slug)] : []),
    ...(args["content-type"] ? ["--content-type", String(args["content-type"])] : []),
    ...(args["response-headers"] ? ["--response-headers", resolve(String(args["response-headers"]))] : []),
    ...(args["inspect-only"] ? ["--inspect-only"] : []),
  ],
  stdout: "inherit",
  stderr: "inherit",
});
const out = await cmd.output();
Deno.exit(out.code);
