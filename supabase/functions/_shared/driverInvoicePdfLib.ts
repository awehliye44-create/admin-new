import { PDFDocument, StandardFonts, type PDFFont, type PDFImage, type PDFPage } from "npm:pdf-lib@1.17.1";
import { PDF_COLORS } from "./driverInvoiceBrand.ts";
import {
  buildDisplaySummaryRows,
  type DriverInvoiceRenderData,
} from "./driverInvoiceHtml.ts";

function money(pence: number, currency: string): string {
  const sym = currency === "GBP" ? "£" : currency === "USD" ? "$" : `${currency} `;
  return `${sym}${(Math.abs(pence) / 100).toFixed(2)}`;
}

function formatAmount(
  row: { isDeduction?: boolean; amountPence: number },
  currency: string,
): string {
  const prefix = row.isDeduction && row.amountPence !== 0 ? "-" : "";
  return `${prefix}${money(row.amountPence, currency)}`;
}

function drawText(
  page: PDFPage,
  font: PDFFont,
  fontBold: PDFFont,
  text: string,
  x: number,
  yPos: number,
  size = 10,
  bold = false,
  color = PDF_COLORS.darkText,
) {
  page.drawText(text, {
    x,
    y: yPos,
    size,
    font: bold ? fontBold : font,
    color,
  });
}

function drawRightText(
  page: PDFPage,
  font: PDFFont,
  fontBold: PDFFont,
  text: string,
  xRight: number,
  yPos: number,
  size = 10,
  bold = false,
  color = PDF_COLORS.darkText,
) {
  const activeFont = bold ? fontBold : font;
  const width = activeFont.widthOfTextAtSize(text, size);
  drawText(page, font, fontBold, text, xRight - width, yPos, size, bold, color);
}

function drawBadge(
  page: PDFPage,
  font: PDFFont,
  fontBold: PDFFont,
  text: string,
  xRight: number,
  yPos: number,
) {
  const activeFont = fontBold;
  const width = activeFont.widthOfTextAtSize(text, 10) + 24;
  const x = xRight - width;
  page.drawRectangle({
    x,
    y: yPos - 4,
    width,
    height: 20,
    color: PDF_COLORS.gold,
    borderWidth: 0,
  });
  drawText(page, font, fontBold, text, x + 12, yPos, 10, true, PDF_COLORS.black);
}

async function embedLogo(pdf: PDFDocument, logoUrl?: string): Promise<PDFImage | null> {
  if (!logoUrl) return null;
  try {
    const response = await fetch(logoUrl);
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    const lower = logoUrl.toLowerCase();
    if (lower.includes(".png") || lower.startsWith("data:image/png")) return pdf.embedPng(bytes);
    if (lower.includes(".jpg") || lower.includes(".jpeg") || lower.includes(".webp") || lower.startsWith("data:image/jpeg")) {
      return pdf.embedJpg(bytes);
    }
    try {
      return await pdf.embedPng(bytes);
    } catch {
      return await pdf.embedJpg(bytes);
    }
  } catch {
    return null;
  }
}

function drawDetailCard(
  page: PDFPage,
  font: PDFFont,
  fontBold: PDFFont,
  title: string,
  rows: Array<[string, string]>,
  x: number,
  yTop: number,
  width: number,
): number {
  const height = 24 + rows.length * 18 + 12;
  page.drawRectangle({
    x,
    y: yTop - height,
    width,
    height,
    borderColor: PDF_COLORS.lightBorder,
    borderWidth: 1,
    color: PDF_COLORS.white,
  });
  page.drawCircle({
    x: x + 22,
    y: yTop - 18,
    size: 8,
    color: PDF_COLORS.gold,
    borderWidth: 0,
  });
  drawText(page, font, fontBold, title, x + 36, yTop - 18, 9, true, PDF_COLORS.black);
  let y = yTop - 36;
  for (const [label, value] of rows) {
    drawText(page, font, fontBold, label, x + 12, y, 8, false, PDF_COLORS.mutedText);
    drawRightText(page, font, fontBold, value, x + width - 12, y, 8, true, PDF_COLORS.darkText);
    page.drawLine({
      start: { x: x + 12, y: y - 6 },
      end: { x: x + width - 12, y: y - 6 },
      thickness: 0.5,
      color: PDF_COLORS.lightBorder,
    });
    y -= 18;
  }
  return yTop - height;
}

/** pdf-lib fallback renderer — mirrors the branded HTML template layout. */
export async function renderDriverInvoicePdfLib(data: DriverInvoiceRenderData): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595.28, 841.89]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const left = 40;
  const right = 555;
  const contentWidth = right - left;
  let y = 800;

  const companyName = data.company.legalName || data.company.name || "ONECAB";
  const tagline = data.branding.tagline || "One App. Every Journey.";
  const invoiceTitle = data.invoiceTitle || "Driver Earnings Statement";

  const logo = await embedLogo(pdf, data.branding.logoUrl);
  if (logo) {
    const logoHeight = 44;
    const logoWidth = logoHeight * (logo.width / logo.height);
    page.drawImage(logo, { x: left, y: y - logoHeight + 8, width: logoWidth, height: logoHeight });
    y -= logoHeight + 4;
  } else {
    drawText(page, font, fontBold, "ONE", left, y, 28, true, PDF_COLORS.black);
    drawText(page, font, fontBold, "CAB", left + 58, y, 28, true, PDF_COLORS.gold);
    y -= 34;
  }

  drawText(page, font, fontBold, companyName, left, y, 12, true, PDF_COLORS.black);
  drawText(page, font, fontBold, tagline.toUpperCase(), left, y - 14, 8, true, PDF_COLORS.gold);

  drawRightText(page, font, fontBold, invoiceTitle, right, 800, 18, true, PDF_COLORS.black);
  drawBadge(page, font, fontBold, `#${data.invoiceNo}`, right, 772);
  drawBadge(page, font, fontBold, data.invoiceStatus, right, 748);

  y -= 28;
  page.drawLine({ start: { x: left, y }, end: { x: right, y }, thickness: 3, color: PDF_COLORS.gold });
  y -= 24;

  const cardWidth = (contentWidth - 16) / 2;
  const cardTop = y;
  const leftBottom = drawDetailCard(page, font, fontBold, "DRIVER DETAILS", [
    ["Invoice Number", data.invoiceNo],
    ["Driver Name", data.driverName],
    ["Driver ID", data.driverId],
    ["Region", data.regionName],
    ["Currency", data.currency],
  ], left, cardTop, cardWidth);

  const rightBottom = drawDetailCard(page, font, fontBold, "INVOICE DETAILS", [
    ["Invoice Period", data.invoicePeriod],
    ["Generated Date", data.generatedDate],
    ["Statement Type", invoiceTitle],
    ["Total Trips", String(data.totalTrips)],
    ["Card Trips", String(data.cardTrips)],
    ["Cash Trips", String(data.cashTrips)],
  ], left + cardWidth + 16, cardTop, cardWidth);

  y = Math.min(leftBottom, rightBottom) - 24;

  page.drawRectangle({ x: left, y: y - 4, width: contentWidth, height: 22, color: PDF_COLORS.black });
  drawText(page, font, fontBold, "DESCRIPTION", left + 10, y, 8, true, PDF_COLORS.gold);
  drawText(page, font, fontBold, "TRIPS", 360, y, 8, true, PDF_COLORS.gold);
  drawText(page, font, fontBold, `AMOUNT (${data.currency === "GBP" ? "£" : data.currency})`, 430, y, 8, true, PDF_COLORS.gold);
  y -= 22;

  for (const row of buildDisplaySummaryRows(data)) {
    if (y < 150) break;
    drawText(page, font, fontBold, row.description.slice(0, 42), left + 10, y, 9, false, PDF_COLORS.darkText);
    drawText(
      page,
      font,
      fontBold,
      row.trips > 0 ? String(row.trips) : "—",
      372,
      y,
      9,
      false,
      PDF_COLORS.darkText,
    );
    const amountColor = row.isDeduction && row.amountPence !== 0
      ? PDF_COLORS.deductionRed
      : row.isPositive && row.amountPence > 0
      ? PDF_COLORS.positiveGreen
      : PDF_COLORS.darkText;
    drawText(page, font, fontBold, formatAmount(row, data.currency), 430, y, 9, true, amountColor);
    page.drawLine({
      start: { x: left, y: y - 5 },
      end: { x: right, y: y - 5 },
      thickness: 0.5,
      color: PDF_COLORS.lightBorder,
    });
    y -= 18;
  }

  y -= 12;
  const netBoxWidth = 320;
  const netBoxX = right - netBoxWidth;
  const netBoxHeight = 58;
  page.drawRectangle({
    x: netBoxX,
    y: y - netBoxHeight,
    width: netBoxWidth,
    height: netBoxHeight,
    color: PDF_COLORS.goldLight,
    borderColor: PDF_COLORS.gold,
    borderWidth: 2,
  });
  page.drawLine({
    start: { x: netBoxX, y: y },
    end: { x: right, y },
    thickness: 3,
    color: PDF_COLORS.gold,
  });
  drawText(page, font, fontBold, "NET DRIVER EARNINGS", netBoxX + 14, y - 24, 10, true, PDF_COLORS.black);
  drawText(
    page,
    font,
    fontBold,
    money(data.netDriverEarningsPence, data.currency),
    netBoxX + 14,
    y - 44,
    20,
    true,
    PDF_COLORS.black,
  );

  y -= netBoxHeight + 28;
  drawText(page, font, fontBold, companyName, left, y, 12, true, PDF_COLORS.black);
  drawText(page, font, fontBold, tagline.toUpperCase(), left, y - 16, 8, true, PDF_COLORS.gold);
  let footerY = y - 32;
  if (data.company.address) {
    drawText(page, font, fontBold, data.company.address.slice(0, 90), left, footerY, 9, false, PDF_COLORS.mutedText);
    footerY -= 12;
  }
  if (data.company.website) {
    drawText(page, font, fontBold, data.company.website, left, footerY, 9, false, PDF_COLORS.mutedText);
    footerY -= 12;
  }
  if (data.company.phone) {
    drawText(page, font, fontBold, data.company.phone, left, footerY, 9, false, PDF_COLORS.mutedText);
    footerY -= 12;
  }
  if (data.company.email) {
    drawText(page, font, fontBold, data.company.email, left, footerY, 9, false, PDF_COLORS.mutedText);
  }

  return pdf.save();
}
