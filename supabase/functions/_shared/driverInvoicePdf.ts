import { PDFDocument, StandardFonts, rgb } from "npm:pdf-lib@1.17.1";
import type { DriverInvoiceRenderData } from "./driverInvoiceHtml.ts";

const GOLD = rgb(0.957, 0.706, 0);
const BLACK = rgb(0.067, 0.067, 0.067);
const RED = rgb(0.863, 0.149, 0.149);
const GRAY = rgb(0.4, 0.4, 0.4);

function money(pence: number, currency: string): string {
  const sym = currency === "GBP" ? "£" : "$";
  return `${sym}${(pence / 100).toFixed(2)}`;
}

export async function buildDriverInvoicePdf(data: DriverInvoiceRenderData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595.28, 841.89]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  let y = 800;
  const left = 40;

  const draw = (text: string, x: number, yPos: number, size = 10, bold = false, color = BLACK) => {
    page.drawText(text, { x, y: yPos, size, font: bold ? fontBold : font, color });
  };

  draw("ONE", left, y, 28, true);
  draw("CAB", left + 58, y, 28, true, GOLD);
  draw(data.invoiceTitle.toUpperCase(), 380, y, 24, true);
  page.drawRectangle({ x: 380, y: y - 36, width: 130, height: 20, color: GOLD });
  draw(`#${data.invoiceNo}`, 388, y - 30, 10, true);
  y -= 60;

  draw(`Driver: ${data.driverName}`, left, y, 10, true); y -= 14;
  draw(`Driver ID: ${data.driverId}`, left, y); y -= 14;
  draw(`Region: ${data.regionName}  |  Currency: ${data.currency}`, left, y); y -= 14;
  draw(`Period: ${data.invoicePeriod}`, left, y); y -= 14;
  draw(`Status: ${data.invoiceStatus}  |  Generated: ${data.generatedDate}`, left, y); y -= 20;

  page.drawLine({ start: { x: left, y }, end: { x: 555, y }, thickness: 2, color: GOLD });
  y -= 22;

  page.drawRectangle({ x: left, y: y - 4, width: 515, height: 18, color: BLACK });
  draw("DESCRIPTION", left + 4, y, 8, true, GOLD);
  draw("TRIPS", 340, y, 8, true, GOLD);
  draw("AMOUNT", 480, y, 8, true, GOLD);
  y -= 20;

  for (const row of data.summaryRows) {
    draw(row.description.slice(0, 42), left + 4, y, 9);
    draw(row.trips ? String(row.trips) : "—", 350, y, 9);
    const amt = `${row.isDeduction ? "-" : ""}${money(Math.abs(row.amountPence), data.currency)}`;
    draw(amt, 460, y, 9, false, row.isDeduction ? RED : BLACK);
    y -= 14;
    if (y < 200) break;
  }

  y -= 10;
  draw(`Total Trips: ${data.totalTrips}  |  Cash: ${data.cashTrips}  |  Card: ${data.cardTrips}`, left, y, 9);
  y -= 16;
  draw(`Gross: ${money(data.grossEarningsPence, data.currency)}`, left, y, 9);
  draw(`Commission: -${money(data.platformCommissionPence, data.currency)}`, 200, y, 9, false, RED);
  y -= 14;
  draw(`Cash Offset: -${money(data.cashCollectedOffsetPence, data.currency)}`, left, y, 9, false, RED);
  y -= 18;

  page.drawRectangle({ x: 300, y: y - 8, width: 255, height: 30, color: rgb(1, 0.973, 0.882) });
  draw("NET DRIVER EARNINGS", 310, y, 12, true);
  draw(money(data.netDriverEarningsPence, data.currency), 460, y, 14, true);

  return pdf.save();
}
