/**
 * Customer trip invoice PDF builder (pdf-lib).
 * Restored so customer-trip-invoice can deploy clean Revolut-era invoice SSOT.
 */

import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";
import type { TripInvoicePayload } from "./tripInvoiceTypes.ts";

function money(pence: number, currency = "GBP"): string {
  const amount = (Number(pence) || 0) / 100;
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(amount);
  } catch {
    return `£${amount.toFixed(2)}`;
  }
}

export async function buildTripInvoicePdf(payload: TripInvoicePayload): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595.28, 841.89]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.07, 0.07, 0.07);
  const muted = rgb(0.35, 0.35, 0.35);
  const gold = rgb(0.96, 0.7, 0.004);

  let y = 800;
  const left = 40;
  page.drawText("ONECAB", { x: left, y, size: 22, font: bold, color: ink });
  page.drawRectangle({ x: left, y: y - 10, width: 515, height: 2, color: gold });
  y -= 36;

  page.drawText(`Invoice ${payload.invoiceNo}`, { x: left, y, size: 14, font: bold, color: ink });
  y -= 18;
  page.drawText(`Trip ${payload.tripId} · ${payload.invoiceDate}`, {
    x: left,
    y,
    size: 10,
    font,
    color: muted,
  });
  y -= 28;

  for (const line of [
    `Bill to: ${payload.customerName || "Customer"}`,
    payload.customerEmail || "",
    payload.customerPhone || "",
    `Payment: ${payload.paymentMethod || "card"}`,
    `Pickup: ${payload.pickupAddress || ""}`,
    `Dropoff: ${payload.dropoffAddress || ""}`,
  ]) {
    if (!line.trim()) continue;
    page.drawText(line.slice(0, 95), { x: left, y, size: 10, font, color: ink });
    y -= 14;
  }

  y -= 12;
  page.drawText("Charges", { x: left, y, size: 12, font: bold, color: ink });
  y -= 18;
  for (const item of payload.lineItems ?? []) {
    if (y < 80) break;
    const desc = String(item.description ?? "Item").slice(0, 60);
    const amt = money(item.amountPence, payload.currency || "GBP");
    page.drawText(desc, { x: left, y, size: 10, font, color: ink });
    page.drawText(amt, {
      x: 480 - font.widthOfTextAtSize(amt, 10),
      y,
      size: 10,
      font,
      color: ink,
    });
    y -= 14;
  }

  y -= 10;
  const total = money(payload.netPaidAfterRefundPence ?? payload.totalPaidPence, payload.currency || "GBP");
  page.drawText(`Total paid: ${total}`, { x: left, y, size: 12, font: bold, color: ink });

  return pdf.save();
}
