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

function esc(s: string): string {
  return s
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

export function buildDriverInvoiceEmail(args: {
  driverName: string;
  invoiceNo: string;
  invoicePeriod: string;
  totalTrips: number;
  netDriverEarnings: string;
  companyName: string;
  companyAddress: string;
  companyPhone: string;
  companyEmail: string;
  companyWebsite: string;
  emailBodyTemplate?: string;
}): { subject: string; html: string; text: string } {
  const text = (args.emailBodyTemplate || `Dear {{driverName}},

Thank you for driving with ONECAB.

Your monthly earnings statement for {{invoicePeriod}} has been generated and is attached as a PDF.

Invoice Number: {{invoiceNo}}
Total Trips: {{totalTrips}}
Net Driver Earnings: {{netDriverEarnings}}

Please review the attached statement for your records.

If you have any questions regarding your earnings, please contact the ONECAB support team.

Kind regards,
ONECAB Team
One App. Every Journey.

{{companyName}}
{{companyAddress}}
Phone: {{companyPhone}}
Email: {{companyEmail}}
Website: {{companyWebsite}}`)
    .replace(/\{\{driverName\}\}/g, args.driverName)
    .replace(/\{\{invoiceNo\}\}/g, args.invoiceNo)
    .replace(/\{\{invoicePeriod\}\}/g, args.invoicePeriod)
    .replace(/\{\{totalTrips\}\}/g, String(args.totalTrips))
    .replace(/\{\{netDriverEarnings\}\}/g, args.netDriverEarnings)
    .replace(/\{\{companyName\}\}/g, args.companyName)
    .replace(/\{\{companyAddress\}\}/g, args.companyAddress)
    .replace(/\{\{companyPhone\}\}/g, args.companyPhone)
    .replace(/\{\{companyEmail\}\}/g, args.companyEmail)
    .replace(/\{\{companyWebsite\}\}/g, args.companyWebsite);

  const html = text.split("\n").map((line) => `<p>${esc(line)}</p>`).join("");
  return {
    subject: `Your ONECAB Monthly Earnings Statement - ${args.invoiceNo}`,
    html,
    text,
  };
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
