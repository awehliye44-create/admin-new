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

function triggerDownload(filename: string, body: string, mime: string): void {
  const blob = new Blob([body], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
