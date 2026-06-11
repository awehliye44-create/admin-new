import {
  buildDriverInvoiceHtml,
  prepareDriverInvoiceHtmlForPdf,
  type DriverInvoiceRenderData,
} from "./driverInvoiceHtml.ts";
import { renderDriverInvoicePdfLib } from "./driverInvoicePdfLib.ts";

const BRANDED_PDF_MARKER = "NET DRIVER EARNINGS";

export function isValidPdfBytes(bytes: Uint8Array): boolean {
  return bytes.length > 5 && new TextDecoder().decode(bytes.slice(0, 5)).startsWith("%PDF");
}

export function isBrandedDriverInvoicePdf(bytes: Uint8Array): boolean {
  if (!isValidPdfBytes(bytes)) return false;
  const sample = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.length, 250_000)));
  return sample.includes(BRANDED_PDF_MARKER) || sample.includes("Driver Earnings Statement");
}

async function convertHtmlWithBrowserless(html: string): Promise<Uint8Array | null> {
  const token = Deno.env.get("BROWSERLESS_TOKEN")?.trim();
  if (!token) return null;

  const baseUrl = (Deno.env.get("BROWSERLESS_URL") || "https://production-sfo.browserless.io").replace(/\/$/, "");
  const response = await fetch(`${baseUrl}/pdf?token=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      html,
      options: {
        printBackground: true,
        format: "A4",
        margin: { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" },
      },
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.warn("[DRIVER_INVOICE] browserless_pdf_failed", response.status, detail.slice(0, 300));
    return null;
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  return isValidPdfBytes(bytes) ? bytes : null;
}

/** Generate a branded PDF from the HTML invoice template, with pdf-lib fallback. */
export async function buildDriverInvoicePdf(data: DriverInvoiceRenderData): Promise<Uint8Array> {
  const html = await prepareDriverInvoiceHtmlForPdf(data);

  const browserlessPdf = await convertHtmlWithBrowserless(html);
  if (browserlessPdf) {
    console.log("[DRIVER_INVOICE] pdf_generated_via_html", { invoiceNo: data.invoiceNo });
    return browserlessPdf;
  }

  console.log("[DRIVER_INVOICE] pdf_generated_via_lib_fallback", { invoiceNo: data.invoiceNo });
  return renderDriverInvoicePdfLib(data);
}

export async function buildDriverInvoicePdfFromHtml(html: string, fallbackData?: DriverInvoiceRenderData): Promise<Uint8Array> {
  const browserlessPdf = await convertHtmlWithBrowserless(html);
  if (browserlessPdf) return browserlessPdf;
  if (fallbackData) return renderDriverInvoicePdfLib(fallbackData);
  throw new Error("HTML to PDF conversion failed and no fallback data was provided");
}

export { buildDriverInvoiceHtml, prepareDriverInvoiceHtmlForPdf };
