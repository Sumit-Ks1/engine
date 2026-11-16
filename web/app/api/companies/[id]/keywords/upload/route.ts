import ExcelJS from 'exceljs';
import { NextResponse, type NextRequest } from 'next/server';
import { engine } from '@/lib/engine';
import { safeId } from '@/lib/ids';
import { entriesFromRows, rowsFromText, type Entry } from '@/lib/sheet';
import type { PlatformId } from '@/lib/types';

export const runtime = 'nodejs';
const MAX_BYTES = 5 * 1024 * 1024;

const cellText = (v: ExcelJS.CellValue): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if ('richText' in v) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return String(v.text);
    if ('result' in v) return String(v.result ?? '');
    return '';
  }
  return String(v);
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const form = await req.formData().catch(() => null);
  const file = form?.get('file');
  if (!(file instanceof File)) return NextResponse.json({ error: 'No file received.' }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: 'File is larger than 5 MB.' }, { status: 413 });

  const name = file.name.toLowerCase();
  const entries: Entry[] = [];
  const columns = new Set<PlatformId>();
  const take = (rows: string[][]) => {
    const parsed = entriesFromRows(rows);
    entries.push(...parsed.entries);
    parsed.columns.forEach((c) => columns.add(c));
  };
  try {
    if (name.endsWith('.xlsx')) {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(await file.arrayBuffer());
      wb.eachSheet((sheet) => {
        const rows: string[][] = [];
        sheet.eachRow((row) => {
          const cells: string[] = [];
          row.eachCell((cell, col) => { cells[col - 1] = cellText(cell.value); });
          rows.push(Array.from(cells, (c) => c ?? ''));
        });
        take(rows);
      });
    } else if (name.endsWith('.csv') || name.endsWith('.txt')) {
      take(rowsFromText(await file.text()));
    } else {
      return NextResponse.json({ error: 'Upload an .xlsx, .csv or .txt file.' }, { status: 415 });
    }
  } catch {
    return NextResponse.json({ error: 'That file could not be read. Save it as .xlsx and try again.' }, { status: 400 });
  }
  if (!entries.length) return NextResponse.json({ error: 'No keywords found in that file.' }, { status: 400 });
  if (entries.length > 5000) return NextResponse.json({ error: 'A file can hold at most 5000 keywords.' }, { status: 400 });

  const res = await engine(`/companies/${safeId((await params).id)}/keywords`, { method: 'POST', body: { terms: entries } });
  if (!res.ok) return res;
  return NextResponse.json({ ...(await res.json()), columns: [...columns] });
}
