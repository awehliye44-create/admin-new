/**
 * Ambient shims so shared edge-function modules (imported by the admin app
 * through `shared/*` re-exports) typecheck under the Vite/TS app config.
 * Deno itself resolves these specifiers natively at deploy time.
 */
declare const Deno: {
  env: { get(key: string): string | undefined };
  serve: (handler: (req: Request) => Response | Promise<Response>) => unknown;
};

declare module 'npm:*' {
  const value: any;
  export = value;
}

declare module 'https://*' {
  const value: any;
  export = value;
}
