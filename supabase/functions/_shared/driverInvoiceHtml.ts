import { ONECAB } from "./driverInvoiceBrand.ts";
import type { CompanyInfo, BrandingSettings } from "./companyBranding.ts";

export interface DriverInvoiceRenderData {
  invoiceNo: string;
  invoiceTitle: string;
  driverName: string;
  driverId: string;
  regionName: string;
  currency: string;
  invoicePeriod: string;
  invoiceStatus: string;
  generatedDate: string;
  summaryRows: Array<{ description: string; trips: number; amountPence: number; isDeduction?: boolean }>;
  totalTrips: number;
  cashTrips: number;
  cardTrips: number;
  grossEarningsPence: number;
  airportFeeEarningsPence: number;
  extraChargeEarningsPence: number;
  bonusesPence: number;
  adjustmentsPence: number;
  platformCommissionPence: number;
  cashCollectedOffsetPence: number;
  netDriverEarningsPence: number;
  company: CompanyInfo;
  branding: BrandingSettings;
  footerText?: string;
}

export interface DisplaySummaryRow {
  description: string;
  trips: number;
  amountPence: number;
  isDeduction?: boolean;
  isPositive?: boolean;
}

export function buildDisplaySummaryRows(data: DriverInvoiceRenderData): DisplaySummaryRow[] {
  const amountFor = (description: string) =>
    data.summaryRows.find((row) => row.description === description)?.amountPence ?? 0;

  return [
    {
      description: "Completed Card Trip Earnings",
      trips: data.cardTrips,
      amountPence: amountFor("Completed Card Trip Earnings"),
      isPositive: true,
    },
    {
      description: "Completed Cash Trip Earnings",
      trips: data.cashTrips,
      amountPence: amountFor("Completed Cash Trip Earnings"),
      isPositive: true,
    },
    {
      description: "Airport Fee Earnings",
      trips: 0,
      amountPence: data.airportFeeEarningsPence,
      isPositive: data.airportFeeEarningsPence > 0,
    },
    {
      description: "Extra Charge Earnings",
      trips: 0,
      amountPence: data.extraChargeEarningsPence,
      isPositive: data.extraChargeEarningsPence > 0,
    },
    {
      description: "Bonuses",
      trips: 0,
      amountPence: data.bonusesPence,
      isPositive: data.bonusesPence > 0,
    },
    {
      description: "Adjustments",
      trips: 0,
      amountPence: data.adjustmentsPence,
      isPositive: data.adjustmentsPence > 0,
    },
    {
      description: "Platform Commission",
      trips: 0,
      amountPence: data.platformCommissionPence,
      isDeduction: true,
    },
    {
      description: "Cash Collected (Offset)",
      trips: 0,
      amountPence: data.cashCollectedOffsetPence,
      isDeduction: true,
    },
  ];
}

function money(pence: number, currency: string): string {
  const sym = currency === "GBP" ? "£" : currency === "USD" ? "$" : `${currency} `;
  return `${sym}${(Math.abs(pence) / 100).toFixed(2)}`;
}

function esc(s: string | null | undefined): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function amountClass(row: { isDeduction?: boolean; isPositive?: boolean; amountPence: number }): string {
  if (row.isDeduction && row.amountPence !== 0) return "amount deduction";
  if (row.isPositive && row.amountPence > 0) return "amount positive";
  return "amount";
}

function formatAmount(row: { isDeduction?: boolean; amountPence: number }, currency: string): string {
  const prefix = row.isDeduction && row.amountPence !== 0 ? "−" : "";
  return `${prefix}${money(row.amountPence, currency)}`;
}

function currencySymbol(currency: string): string {
  return currency === "GBP" ? "£" : currency === "USD" ? "$" : currency;
}

export function buildDriverInvoiceHtml(data: DriverInvoiceRenderData): string {
  const logoBlock = data.branding.logoUrl
    ? `<img src="${esc(data.branding.logoUrl)}" alt="${esc(data.company.name || "ONECAB")}" class="logo-img" />`
    : `<div class="logo-text"><span class="one">ONE</span><span class="cab">CAB</span></div>`;

  const tagline = esc(data.branding.tagline || "One App. Every Journey.");
  const companyName = esc(data.company.legalName || data.company.name || "ONECAB");
  const invoiceTitle = esc(data.invoiceTitle || "Driver Earnings Statement");
  const companyAddress = data.company.address ? esc(data.company.address) : "";

  const rows = buildDisplaySummaryRows(data).map((row) => `
    <tr>
      <td class="col-desc">${esc(row.description)}</td>
      <td class="col-trips">${row.trips > 0 ? row.trips : "—"}</td>
      <td class="${amountClass(row)}">${formatAmount(row, data.currency)}</td>
    </tr>
  `).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${companyName} — ${invoiceTitle} ${esc(data.invoiceNo)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Helvetica Neue', Arial, sans-serif;
      background: ${ONECAB.white};
      color: ${ONECAB.darkText};
      font-size: 12px;
      line-height: 1.5;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .page { max-width: 820px; margin: 0 auto; padding: 28px 36px 40px; background: ${ONECAB.white}; }
    .header { display: flex; justify-content: space-between; align-items: flex-start; gap: 24px; }
    .brand-block { display: flex; flex-direction: column; gap: 6px; }
    .logo-img { max-height: 56px; max-width: 220px; object-fit: contain; }
    .logo-text { font-size: 34px; font-weight: 800; letter-spacing: -1px; line-height: 1; }
    .logo-text .one { color: ${ONECAB.black}; }
    .logo-text .cab { color: ${ONECAB.gold}; }
    .company-name { font-size: 15px; font-weight: 800; color: ${ONECAB.black}; letter-spacing: 0.2px; }
    .company-tagline { font-size: 11px; font-weight: 700; color: ${ONECAB.gold}; letter-spacing: 0.8px; text-transform: uppercase; }
    .header-right { text-align: right; }
    .doc-title { font-size: 22px; font-weight: 800; color: ${ONECAB.black}; letter-spacing: 0.2px; }
    .badges { margin-top: 12px; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
    .badge {
      display: inline-block;
      padding: 7px 16px;
      background: ${ONECAB.gold};
      color: ${ONECAB.black};
      border-radius: 999px;
      font-weight: 700;
      font-size: 12px;
    }
    .gold-line { height: 3px; background: ${ONECAB.gold}; margin: 22px 0 24px; border: none; }
    .cards { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
    .card {
      background: ${ONECAB.white};
      border: 1px solid ${ONECAB.lightBorder};
      border-radius: 12px;
      padding: 16px;
    }
    .card-title {
      font-size: 11px;
      font-weight: 800;
      letter-spacing: 0.6px;
      text-transform: uppercase;
      color: ${ONECAB.black};
      margin-bottom: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .icon-dot {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      background: ${ONECAB.gold};
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      flex-shrink: 0;
      color: ${ONECAB.black};
    }
    .detail-row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      padding: 6px 0;
      border-bottom: 1px solid ${ONECAB.lightBorder};
      font-size: 11px;
    }
    .detail-row:last-child { border-bottom: none; }
    .detail-row span:first-child { color: ${ONECAB.mutedText}; }
    .detail-row span:last-child { color: ${ONECAB.darkText}; font-weight: 600; text-align: right; }
    table { width: 100%; border-collapse: collapse; margin-top: 28px; }
    thead tr { background: ${ONECAB.black}; color: ${ONECAB.gold}; }
    thead th {
      padding: 12px 14px;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.5px;
      text-align: left;
      text-transform: uppercase;
    }
    thead th.center { text-align: center; }
    thead th.right { text-align: right; }
    tbody td {
      padding: 12px 14px;
      border-bottom: 1px solid ${ONECAB.lightBorder};
      font-size: 11px;
      color: ${ONECAB.darkText};
      vertical-align: top;
    }
    .col-trips { text-align: center; width: 80px; }
    .amount { text-align: right; font-weight: 700; color: ${ONECAB.darkText}; }
    .amount.positive { color: ${ONECAB.positiveGreen}; }
    .amount.deduction { color: ${ONECAB.deductionRed}; }
    .net-box {
      margin-top: 24px;
      margin-left: auto;
      width: min(100%, 380px);
      background: ${ONECAB.goldLight};
      border: 2px solid ${ONECAB.gold};
      border-top: 3px solid ${ONECAB.gold};
      border-radius: 12px;
      padding: 20px 22px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
    }
    .net-label {
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.4px;
      text-transform: uppercase;
      color: ${ONECAB.black};
    }
    .net-amount {
      font-size: 26px;
      font-weight: 800;
      color: ${ONECAB.black};
      white-space: nowrap;
    }
    .footer {
      margin-top: 36px;
      padding-top: 20px;
      border-top: 2px solid ${ONECAB.gold};
      text-align: center;
    }
    .footer h4 {
      font-size: 16px;
      font-weight: 800;
      color: ${ONECAB.black};
      margin-bottom: 4px;
    }
    .footer .tagline {
      font-size: 11px;
      font-weight: 700;
      color: ${ONECAB.gold};
      letter-spacing: 0.8px;
      text-transform: uppercase;
      margin-bottom: 10px;
    }
    .footer p { color: ${ONECAB.mutedText}; font-size: 11px; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="page">
    <div class="header">
      <div class="brand-block">
        ${logoBlock}
        <div class="company-name">${companyName}</div>
        <div class="company-tagline">${tagline}</div>
      </div>
      <div class="header-right">
        <div class="doc-title">${invoiceTitle}</div>
        <div class="badges">
          <span class="badge">#${esc(data.invoiceNo)}</span>
          <span class="badge">${esc(data.invoiceStatus)}</span>
        </div>
      </div>
    </div>

    <hr class="gold-line" />

    <div class="cards">
      <div class="card">
        <div class="card-title"><span class="icon-dot">👤</span> Driver Details</div>
        <div class="detail-row"><span>Invoice Number</span><span>${esc(data.invoiceNo)}</span></div>
        <div class="detail-row"><span>Driver Name</span><span>${esc(data.driverName)}</span></div>
        <div class="detail-row"><span>Driver ID</span><span>${esc(data.driverId)}</span></div>
        <div class="detail-row"><span>Region</span><span>${esc(data.regionName)}</span></div>
        <div class="detail-row"><span>Currency</span><span>${esc(data.currency)}</span></div>
      </div>
      <div class="card">
        <div class="card-title"><span class="icon-dot">📄</span> Invoice Details</div>
        <div class="detail-row"><span>Invoice Period</span><span>${esc(data.invoicePeriod)}</span></div>
        <div class="detail-row"><span>Generated Date</span><span>${esc(data.generatedDate)}</span></div>
        <div class="detail-row"><span>Statement Type</span><span>${invoiceTitle}</span></div>
        <div class="detail-row"><span>Total Trips</span><span>${data.totalTrips}</span></div>
        <div class="detail-row"><span>Card Trips</span><span>${data.cardTrips}</span></div>
        <div class="detail-row"><span>Cash Trips</span><span>${data.cashTrips}</span></div>
      </div>
    </div>

    <table>
      <thead>
        <tr>
          <th>Description</th>
          <th class="center">Trips</th>
          <th class="right">Amount (${esc(currencySymbol(data.currency))})</th>
        </tr>
      </thead>
      <tbody>
        ${rows}
      </tbody>
    </table>

    <div class="net-box">
      <div class="net-label">Net Driver Earnings</div>
      <div class="net-amount">${money(data.netDriverEarningsPence, data.currency)}</div>
    </div>

    <div class="footer">
      <h4>${companyName}</h4>
      <div class="tagline">${tagline}</div>
      ${companyAddress ? `<p>${companyAddress}</p>` : ""}
      ${data.company.website ? `<p>${esc(data.company.website)}</p>` : ""}
      ${data.company.phone ? `<p>${esc(data.company.phone)}</p>` : ""}
      ${data.company.email ? `<p>${esc(data.company.email)}</p>` : ""}
      ${data.footerText ? `<p style="margin-top:10px;">${esc(data.footerText)}</p>` : ""}
    </div>
  </div>
</body>
</html>`;
}

const DRIVER_EMAIL = {
  black: "#0B0F14",
  yellow: "#FFD400",
  white: "#FFFFFF",
  bodyBg: "#F4F4F5",
  muted: "#6B7280",
  supportPhone: "01908 831211",
  supportEmail: "info@onecab.net",
  supportWebsite: "www.onecab.net",
} as const;

export function buildDriverInvoiceEmail(args: {
  driverName: string;
  invoiceNo: string;
  invoicePeriod: string;
  companyPhone?: string;
  companyEmail?: string;
  companyWebsite?: string;
  logoUrl?: string;
}): { subject: string; html: string; text: string } {
  const driverName = esc(args.driverName || "Driver");
  const invoiceNo = esc(args.invoiceNo || "—");
  const invoicePeriod = esc(args.invoicePeriod || "—");
  const phone = esc(args.companyPhone?.trim() || DRIVER_EMAIL.supportPhone);
  const email = esc(args.companyEmail?.trim() || DRIVER_EMAIL.supportEmail);
  const website = esc(
    (args.companyWebsite?.trim() || DRIVER_EMAIL.supportWebsite).replace(/^https?:\/\//i, ""),
  );
  const logoUrl = args.logoUrl?.trim();
  const subject = `Your ONECAB Driver Statement - ${args.invoiceNo || "Statement"}`;

  const text = `ONECAB — Driver Statement

Dear ${args.driverName || "Driver"},

Your ONECAB driver statement is ready.

Statement No: ${args.invoiceNo || "—"}
Period: ${args.invoicePeriod || "—"}

Please find your detailed statement attached as a PDF.

If you have any questions, contact ONECAB Support.

---
ONECAB
One App. Every Journey.
${args.companyEmail?.trim() || DRIVER_EMAIL.supportEmail}
${args.companyPhone?.trim() || DRIVER_EMAIL.supportPhone}
${(args.companyWebsite?.trim() || DRIVER_EMAIL.supportWebsite).replace(/^https?:\/\//i, "")}`;

  const logoBlock = logoUrl
    ? `<img src="${esc(logoUrl)}" alt="ONECAB" width="140" style="display:block;max-width:140px;height:auto;border:0;" />`
    : `<div style="font-size:28px;font-weight:700;color:${DRIVER_EMAIL.white};letter-spacing:2px;line-height:1;">ONECAB</div>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>${subject}</title>
</head>
<body style="margin:0;padding:0;background-color:${DRIVER_EMAIL.bodyBg};font-family:Arial,Helvetica,sans-serif;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${DRIVER_EMAIL.bodyBg};margin:0;padding:24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:600px;background-color:${DRIVER_EMAIL.white};border-radius:8px;overflow:hidden;">
          <tr>
            <td style="background-color:${DRIVER_EMAIL.black};padding:28px 32px 20px;text-align:left;">
              ${logoBlock}
              <div style="margin-top:14px;font-size:13px;font-weight:600;color:${DRIVER_EMAIL.yellow};letter-spacing:1.5px;text-transform:uppercase;">Driver Statement</div>
            </td>
          </tr>
          <tr>
            <td style="height:4px;background-color:${DRIVER_EMAIL.yellow};font-size:0;line-height:0;">&nbsp;</td>
          </tr>
          <tr>
            <td style="padding:32px 32px 8px;color:#111827;font-size:16px;line-height:1.6;">
              <p style="margin:0 0 16px;">Dear ${driverName},</p>
              <p style="margin:0 0 20px;">Your ONECAB driver statement is ready.</p>
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 24px;background-color:#F9FAFB;border:1px solid #E5E7EB;border-radius:8px;">
                <tr>
                  <td style="padding:16px 20px;font-size:14px;line-height:1.7;color:#374151;">
                    <strong style="color:#111827;">Statement No:</strong> ${invoiceNo}<br />
                    <strong style="color:#111827;">Period:</strong> ${invoicePeriod}
                  </td>
                </tr>
              </table>
              <p style="margin:0 0 16px;">Please find your detailed statement attached as a PDF.</p>
              <p style="margin:0;color:${DRIVER_EMAIL.muted};font-size:14px;">If you have any questions, contact ONECAB Support.</p>
            </td>
          </tr>
          <tr>
            <td style="background-color:${DRIVER_EMAIL.black};padding:24px 32px;text-align:center;color:${DRIVER_EMAIL.white};font-size:13px;line-height:1.8;">
              <div style="font-size:16px;font-weight:700;letter-spacing:1px;">ONECAB</div>
              <div style="margin-top:4px;color:${DRIVER_EMAIL.yellow};font-size:12px;letter-spacing:0.5px;">One App. Every Journey.</div>
              <div style="margin-top:14px;font-size:13px;line-height:1.9;">
                <a href="mailto:${email}" style="color:${DRIVER_EMAIL.white};text-decoration:none;">${email}</a><br />
                <span style="color:${DRIVER_EMAIL.white};">${phone}</span><br />
                <a href="https://${website}" style="color:${DRIVER_EMAIL.white};text-decoration:none;">${website}</a>
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  return { subject, html, text };
}

async function fetchAsDataUri(url: string): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const base64 = btoa(binary);
    const contentType = response.headers.get("content-type")
      || (url.toLowerCase().includes(".png") ? "image/png" : "image/jpeg");
    return `data:${contentType};base64,${base64}`;
  } catch {
    return null;
  }
}

/** Inline remote assets so HTML→PDF renderers can embed logos reliably. */
export async function prepareDriverInvoiceHtmlForPdf(data: DriverInvoiceRenderData): Promise<string> {
  let html = buildDriverInvoiceHtml(data);
  const logoUrl = data.branding.logoUrl?.trim();
  if (!logoUrl || logoUrl.startsWith("data:")) return html;

  const dataUri = await fetchAsDataUri(logoUrl);
  if (!dataUri) return html;

  return html.split(logoUrl).join(dataUri);
}
