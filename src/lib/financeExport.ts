/** Finance control-centre exports — CSV / Excel (SpreadsheetML) / print-PDF. No money math. */

export type ExportCell = string | number | null | undefined;

function escapeCsv(v: ExportCell): string {
  return `"${String(v ?? '').replace(/"/g, '""')}"`;
}

export function downloadCsv(
  filename: string,
  rows: Array<Record<string, ExportCell>>,
): void {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  const body = [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => escapeCsv(r[h])).join(',')),
  ].join('\n');
  triggerDownload(filename.endsWith('.csv') ? filename : `${filename}.csv`, body, 'text/csv;charset=utf-8');
}

/** Excel-openable SpreadsheetML (.xls) — no extra dependency. */
export function downloadExcel(
  filename: string,
  sheets: Array<{ name: string; rows: ExportCell[][] }>,
): void {
  if (sheets.length === 0) return;
  const xmlSheets = sheets.map((sheet) => {
    const rowsXml = sheet.rows.map((row) => {
      const cells = row.map((cell) => {
        if (typeof cell === 'number' && Number.isFinite(cell)) {
          return `<Cell><Data ss:Type="Number">${cell}</Data></Cell>`;
        }
        const text = String(cell ?? '')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        return `<Cell><Data ss:Type="String">${text}</Data></Cell>`;
      }).join('');
      return `<Row>${cells}</Row>`;
    }).join('');
    const safeName = sheet.name.replace(/[^\w\s-]/g, '').slice(0, 31) || 'Sheet1';
    return `<Worksheet ss:Name="${safeName}"><Table>${rowsXml}</Table></Worksheet>`;
  }).join('');

  const xml = `<?xml version="1.0"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
${xmlSheets}
</Workbook>`;

  const base = filename.replace(/\.(xlsx|xls|csv)$/i, '');
  triggerDownload(
    `${base}.xls`,
    xml,
    'application/vnd.ms-excel;charset=utf-8',
  );
}

export function downloadRecordsAsExcel(
  filename: string,
  rows: Array<Record<string, ExportCell>>,
  sheetName = 'Export',
): void {
  if (rows.length === 0) return;
  const headers = Object.keys(rows[0]);
  downloadExcel(filename, [{
    name: sheetName,
    rows: [
      headers,
      ...rows.map((r) => headers.map((h) => r[h] ?? null)),
    ],
  }]);
}

export function printFinanceReport(): void {
  window.print();
}

/** Print-to-PDF receipt for a single outgoing payout/transfer (display-only; no money math). */
export function printPayoutReceipt(args: {
  title: string;
  fields: Array<{ label: string; value: ExportCell }>;
}): void {
  if (typeof window === 'undefined') return;
  const escapeHtml = (v: ExportCell) =>
    String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  const rows = args.fields
    .map((f) => `<tr><th>${escapeHtml(f.label)}</th><td>${escapeHtml(f.value)}</td></tr>`)
    .join('');
  const html = `<!DOCTYPE html><html><head><title>${escapeHtml(args.title)}</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 12px; color: #111; margin: 32px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #555; margin-bottom: 20px; }
  table { border-collapse: collapse; width: 100%; max-width: 640px; }
  th, td { border: 1px solid #ddd; padding: 8px 10px; text-align: left; vertical-align: top; }
  th { width: 40%; background: #f7f7f7; font-weight: 600; }
  @media print { body { margin: 0; } }
</style></head><body>
<h1>ONECAB</h1>
<div class="sub">${escapeHtml(args.title)}</div>
<table>${rows}</table>
<script>window.onload=function(){window.print();}</script>
</body></html>`;
  const w = window.open('', '_blank', 'noopener,noreferrer,width=720,height=900');
  if (!w) return;
  w.document.open();
  w.document.write(html);
  w.document.close();
}

/** Open a print-ready PDF view of period-scoped ledger rows (no money math). */
export function printFinanceRecords(
  title: string,
  rows: Array<Record<string, ExportCell>>,
): void {
  if (rows.length === 0 || typeof window === 'undefined') return;
  const headers = Object.keys(rows[0]);
  const escapeHtml = (v: ExportCell) =>
    String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  const thead = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('');
  const tbody = rows
    .map((r) => `<tr>${headers.map((h) => `<td>${escapeHtml(r[h])}</td>`).join('')}</tr>`)
    .join('');
  const html = `<!DOCTYPE html><html><head><title>${escapeHtml(title)}</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; font-size: 11px; color: #111; margin: 24px; }
  h1 { font-size: 16px; margin: 0 0 12px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #ccc; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #f4f4f4; }
  @media print { body { margin: 0; } }
</style></head><body>
<h1>${escapeHtml(title)}</h1>
<table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>
<script>window.onload=function(){window.print();}</script>
</body></html>`;
  const w = window.open('', '_blank', 'noopener,noreferrer,width=960,height=720');
  if (!w) return;
  w.document.open();
  w.document.write(html);
  w.document.close();
}

function triggerDownload(filename: string, body: string, mime: string): void {
  const blob = new Blob([body], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
