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
  export type SupabaseClient = any;
  export type PDFFont = any;
  export type PDFImage = any;
  export type PDFPage = any;
  export type RGB = any;
  export const createClient: any;
  export const PDFDocument: any;
  export const StandardFonts: any;
  export const rgb: any;
  export const RoomServiceClient: any;
  const value: any;
  export default value;
}

declare module 'https://*' {
  const value: any;
  export default value;
}

