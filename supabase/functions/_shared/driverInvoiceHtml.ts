import type { CompanyInfo, BrandingSettings } from "./companyBranding.ts";

const GOLD = "#F4B400";
const GOLD_LIGHT = "#FFF8E1";
const BLACK = "#111111";
const RED = "#DC2626";
const MUTED = "#666666";

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

function money(pence: number, currency: string): string {
  const sym = currency === "GBP" ? "£" : currency === "USD" ? "$" : `${currency} `;
  return `${sym}${(pence / 100).toFixed(2)}`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function buildDriverInvoiceHtml(data: DriverInvoiceRenderData): string {
  const companyLines = [
    data.company.phone ? `Phone: ${esc(data.company.phone)}` : "",
    data.company.email ? `Email: ${esc(data.company.email)}` : "",
    data.company.website ? `Website: ${esc(data.company.website)}` : "",
    data.company.address ? `Address: ${esc(data.company.address)}` : "",
  ].filter(Boolean);

  const logoBlock = data.branding.logoUrl
    ? `<img src="${esc(data.branding.logoUrl)}" alt="ONECAB" class="logo-img" />`
    : `<div class="logo-text"><span class="one">ONE</span><span class="cab">CAB</span></div>`;

  const tableRows = data.summaryRows.map((row) => `
    <tr>
      <td>${esc(row.description)}</td>
      <td class="center">${row.trips || "—"}</td>
      <td class="right ${row.isDeduction ? "deduction" : ""}">${row.isDeduction ? "−" : ""}${money(Math.abs(row.amountPence), data.currency)}</td>
    </tr>
  `).join("");

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/><title>${esc(data.invoiceTitle)} ${esc(data.invoiceNo)}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Helvetica Neue',Arial,sans-serif;background:#fff;color:${BLACK};font-size:12px;line-height:1.45}
  .page{max-width:820px;margin:0 auto;padding:32px 36px 40px}
  .header{display:flex;justify-content:space-between;align-items:flex-start;gap:24px}
  .logo-img{max-height:52px;max-width:200px}
  .logo-text{font-size:34px;font-weight:800}.logo-text .one{color:${BLACK}}.logo-text .cab{color:${GOLD}}
  .tagline{margin-top:6px;font-size:10px;font-weight:700;letter-spacing:1.2px}
  .invoice-title{text-align:right}.invoice-title h1{font-size:36px;font-weight:800}
  .invoice-badge{display:inline-block;margin-top:8px;padding:8px 18px;background:${GOLD};border-radius:999px;font-weight:700}
  .company-meta{margin-top:14px;text-align:right;font-size:11px;color:${MUTED}}
  .divider{height:2px;background:${GOLD};margin:22px 0 24px;border:none}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:18px}
  .section-title{font-size:11px;font-weight:800;margin-bottom:10px}
  .details p{margin-bottom:5px}.details strong{display:inline-block;min-width:130px}
  table{width:100%;border-collapse:collapse;margin-top:24px}
  thead tr{background:${BLACK};color:${GOLD}}
  thead th{padding:11px 10px;font-size:10px;font-weight:800;text-align:left}
  thead th.center{text-align:center} thead th.right{text-align:right}
  tbody td{padding:12px 10px;border-bottom:1px dotted #ddd;font-size:11px}
  .center{text-align:center}.right{text-align:right;font-weight:600}
  .deduction{color:${RED}}
  .summary{margin-top:24px;display:grid;grid-template-columns:1fr 1fr;gap:20px}
  .summary-box{background:#fafafa;border-radius:8px;padding:14px}
  .summary-box h3{font-size:11px;font-weight:800;margin-bottom:10px}
  .summary-row{display:flex;justify-content:space-between;padding:4px 0;font-size:11px}
  .summary-row.deduction{color:${RED}}
  .net-box{margin-top:20px;background:${GOLD_LIGHT};border-radius:12px;padding:18px 20px;display:flex;justify-content:space-between;align-items:center}
  .net-box span:first-child{font-size:14px;font-weight:800}
  .net-box span:last-child{font-size:22px;font-weight:800}
  .footer{margin-top:36px;display:flex;gap:12px;align-items:flex-start}
  .footer h4{font-size:12px;font-weight:800;margin-bottom:4px}
  .footer p{color:${MUTED};font-size:11px}
</style></head><body><div class="page">
  <div class="header">
    <div>${logoBlock}<div class="tagline">ONE APP. <span style="color:${GOLD}">EVERY JOURNEY.</span></div></div>
    <div class="invoice-title">
      <h1>${esc(data.invoiceTitle.toUpperCase())}</h1>
      <div class="invoice-badge">#${esc(data.invoiceNo)}</div>
      <div class="company-meta">${companyLines.map((l) => `<div>${l}</div>`).join("")}</div>
    </div>
  </div>
  <hr class="divider"/>
  <div class="cols">
    <div>
      <div class="section-title">DRIVER</div>
      <div class="details">
        <p><strong>Driver Name:</strong> ${esc(data.driverName)}</p>
        <p><strong>Driver ID:</strong> ${esc(data.driverId)}</p>
        <p><strong>Region:</strong> ${esc(data.regionName)}</p>
        <p><strong>Currency:</strong> ${esc(data.currency)}</p>
      </div>
    </div>
    <div>
      <div class="section-title">STATEMENT DETAILS</div>
      <div class="details">
        <p><strong>Invoice No.:</strong> ${esc(data.invoiceNo)}</p>
        <p><strong>Invoice Period:</strong> ${esc(data.invoicePeriod)}</p>
        <p><strong>Status:</strong> ${esc(data.invoiceStatus)}</p>
        <p><strong>Generated:</strong> ${esc(data.generatedDate)}</p>
      </div>
    </div>
  </div>
  <table>
    <thead><tr><th>DESCRIPTION</th><th class="center">TRIPS</th><th class="right">AMOUNT</th></tr></thead>
    <tbody>${tableRows}</tbody>
  </table>
  <div class="summary">
    <div class="summary-box">
      <h3>TRIP SUMMARY</h3>
      <div class="summary-row"><span>Total Trips</span><span>${data.totalTrips}</span></div>
      <div class="summary-row"><span>Cash Trips</span><span>${data.cashTrips}</span></div>
      <div class="summary-row"><span>Card Trips</span><span>${data.cardTrips}</span></div>
    </div>
    <div class="summary-box">
      <h3>EARNINGS SUMMARY</h3>
      <div class="summary-row"><span>Gross Earnings</span><span>${money(data.grossEarningsPence, data.currency)}</span></div>
      <div class="summary-row"><span>Airport Fee Earnings</span><span>${money(data.airportFeeEarningsPence, data.currency)}</span></div>
      <div class="summary-row"><span>Extra Charge Earnings</span><span>${money(data.extraChargeEarningsPence, data.currency)}</span></div>
      <div class="summary-row"><span>Bonuses</span><span>${money(data.bonusesPence, data.currency)}</span></div>
      <div class="summary-row"><span>Adjustments</span><span>${money(data.adjustmentsPence, data.currency)}</span></div>
      <div class="summary-row deduction"><span>Platform Commission</span><span>−${money(data.platformCommissionPence, data.currency)}</span></div>
      <div class="summary-row deduction"><span>Cash Collected (Offset)</span><span>−${money(data.cashCollectedOffsetPence, data.currency)}</span></div>
    </div>
  </div>
  <div class="net-box"><span>NET DRIVER EARNINGS</span><span>${money(data.netDriverEarningsPence, data.currency)}</span></div>
  <div class="footer">
    <div>
      <h4>THANK YOU FOR DRIVING WITH ONECAB!</h4>
      <p>${esc(data.footerText || "If you have any questions regarding your earnings, please contact our support team.")}</p>
    </div>
  </div>
</div></body></html>`;
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
