/**
 * Customer trip invoice HTML — the existing ONECAB invoice design
 * (white page, black/gold ONECAB wordmark, gold rule, BILL TO / INVOICE DETAILS,
 * app-download panel, journey band, gold table header, totals block).
 */

export interface TripInvoiceLineItem {
  description: string;
  date: string;
  qty: number;
  unit: string;
  amount: string;
}

export interface TripInvoiceHtmlData {
  invoiceNo: string;
  invoiceTitle: string;
  tripRef: string;
  invoiceDate: string;
  paymentMethod: string;
  currencyCode: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  pickupLine: string;
  dropoffLine: string;
  items: TripInvoiceLineItem[];
  subtotal: string;
  taxLabel: string;
  tax: string;
  total: string;
  company: { name: string; email: string; phone: string; website: string; address: string };
  tagline: string;
  footerHeadline: string;
  footerText: string;
}

function esc(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function wordmark(name: string): string {
  const clean = (name || "ONECAB").toUpperCase();
  if (clean.length > 3) {
    return `${esc(clean.slice(0, 3))}<span style="color:#F5B301">${esc(clean.slice(3))}</span>`;
  }
  return esc(clean);
}

export function buildTripInvoiceHtml(data: TripInvoiceHtmlData): string {
  const rows = data.items
    .map(
      (item, index) => `
        <tr>
          <td style="padding:9px 10px;border-bottom:1px solid #ececec;color:#111;font-size:11px;">${index + 1}</td>
          <td style="padding:9px 10px;border-bottom:1px solid #ececec;color:#111;font-size:11px;">${esc(item.description)}</td>
          <td style="padding:9px 10px;border-bottom:1px solid #ececec;color:#444;font-size:11px;">${esc(item.date)}</td>
          <td style="padding:9px 10px;border-bottom:1px solid #ececec;color:#444;font-size:11px;">${item.qty}</td>
          <td style="padding:9px 10px;border-bottom:1px solid #ececec;color:#444;font-size:11px;">${esc(item.unit)}</td>
          <td style="padding:9px 10px;border-bottom:1px solid #ececec;color:#111;font-size:11px;">${esc(item.amount)}</td>
        </tr>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8" />
<style>
  * { box-sizing: border-box; }
  body { margin:0; padding:26px 30px; font-family: Helvetica, Arial, sans-serif; color:#111; background:#ffffff; }
  .muted { color:#555; }
</style></head>
<body>
  <table style="width:100%;border-collapse:collapse;">
    <tr>
      <td style="vertical-align:top;">
        <div style="font-size:30px;font-weight:800;letter-spacing:-0.5px;">${wordmark(data.company.name)}</div>
        <div style="font-size:9px;font-weight:700;letter-spacing:0.4px;margin-top:6px;">${esc(data.tagline || "ONE APP. EVERY JOURNEY.")}</div>
      </td>
      <td style="vertical-align:top;text-align:right;">
        <div style="font-size:30px;font-weight:800;letter-spacing:-0.5px;">${esc(data.invoiceTitle || "INVOICE")}</div>
        <div style="margin-top:12px;">
          <span style="display:inline-block;background:#F5B301;color:#111;font-weight:700;font-size:11px;padding:7px 14px;">#${esc(data.invoiceNo)}</span>
        </div>
        <div style="margin-top:14px;font-size:9.5px;color:#444;line-height:1.55;">
          <div>Phone: ${esc(data.company.phone)}</div>
          <div>Email: ${esc(data.company.email)}</div>
          <div>Website: ${esc(data.company.website)}</div>
          <div>Address:</div>
          <div style="max-width:280px;margin-left:auto;">${esc(data.company.address)}</div>
        </div>
      </td>
    </tr>
  </table>

  <div style="height:3px;background:#F5B301;margin:18px 0 16px;"></div>

  <table style="width:100%;border-collapse:collapse;">
    <tr>
      <td style="width:32%;vertical-align:top;">
        <div style="font-size:11px;font-weight:800;letter-spacing:0.3px;">BILL TO</div>
        <div style="margin-top:8px;font-size:10.5px;line-height:1.7;color:#333;">
          <div>${esc(data.customerName)}</div>
          <div>${esc(data.customerPhone || "—")}</div>
          <div>${esc(data.customerEmail || "—")}</div>
        </div>
      </td>
      <td style="width:36%;vertical-align:top;">
        <div style="font-size:11px;font-weight:800;letter-spacing:0.3px;">INVOICE DETAILS</div>
        <div style="margin-top:8px;font-size:10.5px;line-height:1.7;color:#333;">
          <div>Invoice No.: ${esc(data.invoiceNo)}</div>
          <div>Trip ID: ${esc(data.tripRef)}</div>
          <div>Invoice Date: ${esc(data.invoiceDate)}</div>
          <div>Payment Method: ${esc(data.paymentMethod)}</div>
          <div>Currency: ${esc(data.currencyCode)}</div>
        </div>
      </td>
      <td style="width:32%;vertical-align:top;">
        <div style="background:#f4f4f4;padding:14px;">
          <div style="font-size:9.5px;font-weight:800;color:#111;line-height:1.5;">DOWNLOAD THE<br />${esc((data.company.name || "ONECAB").toUpperCase())} APP</div>
          <div style="margin-top:12px;font-size:9px;color:#333;line-height:1.6;">
            <div style="background:#111;color:#fff;padding:7px 10px;display:inline-block;">GET IT ON Google Play</div>
            <div style="background:#111;color:#fff;padding:7px 10px;display:inline-block;margin-top:6px;">Download on the App Store</div>
          </div>
        </div>
      </td>
    </tr>
  </table>

  <div style="margin-top:16px;background:#f4f4f4;padding:11px 12px;font-size:10px;color:#333;line-height:1.7;">
    <div>Pickup: ${esc(data.pickupLine)}</div>
    <div>Drop-off: ${esc(data.dropoffLine)}</div>
  </div>

  <table style="width:100%;border-collapse:collapse;margin-top:14px;">
    <thead>
      <tr style="background:#F5B301;">
        <th style="text-align:left;padding:8px 10px;font-size:9.5px;letter-spacing:0.4px;color:#111;width:6%;">#</th>
        <th style="text-align:left;padding:8px 10px;font-size:9.5px;letter-spacing:0.4px;color:#111;width:38%;">DESCRIPTION</th>
        <th style="text-align:left;padding:8px 10px;font-size:9.5px;letter-spacing:0.4px;color:#111;width:16%;">DATE</th>
        <th style="text-align:left;padding:8px 10px;font-size:9.5px;letter-spacing:0.4px;color:#111;width:8%;">QTY</th>
        <th style="text-align:left;padding:8px 10px;font-size:9.5px;letter-spacing:0.4px;color:#111;width:14%;">UNIT</th>
        <th style="text-align:left;padding:8px 10px;font-size:9.5px;letter-spacing:0.4px;color:#111;width:18%;">AMOUNT</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  <table style="width:100%;border-collapse:collapse;margin-top:10px;">
    <tr>
      <td style="width:56%;"></td>
      <td style="width:44%;">
        <table style="width:100%;border-collapse:collapse;">
          <tr>
            <td style="padding:6px 10px;font-size:11px;color:#333;">SUBTOTAL</td>
            <td style="padding:6px 10px;font-size:11px;color:#111;text-align:left;">${esc(data.subtotal)}</td>
          </tr>
          <tr>
            <td style="padding:6px 10px;font-size:11px;color:#333;">${esc(data.taxLabel)}</td>
            <td style="padding:6px 10px;font-size:11px;color:#111;text-align:left;">${esc(data.tax)}</td>
          </tr>
          <tr style="background:#F5B301;">
            <td style="padding:9px 10px;font-size:13px;font-weight:800;color:#111;">TOTAL</td>
            <td style="padding:9px 10px;font-size:13px;font-weight:800;color:#111;text-align:left;">${esc(data.total)}</td>
          </tr>
        </table>
      </td>
    </tr>
  </table>

  <div style="margin-top:16px;font-size:12px;font-weight:800;color:#111;">${esc(data.footerHeadline)}</div>
  <div style="margin-top:5px;font-size:10px;color:#555;">${esc(data.footerText)}</div>
</body></html>`;
}
