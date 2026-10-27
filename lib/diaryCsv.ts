/**
 * Pure CSV parsing for diary imports (Letterboxd-style). No network, no Expo: safe to unit test.
 */

export interface ImportRow {
  title: string;
  year: number | null;
  watchedOn: string;
  rating: number | null;
}

/** Parses a Letterboxd-style diary CSV (Date, Name, Year, Rating...). Quoted fields are supported. */
export function parseDiaryCsv(text: string): { rows: ImportRow[]; skipped: number } {
  const lines = splitCsv(text.replace(/^\uFEFF/, ''));
  if (lines.length === 0) return { rows: [], skipped: 0 };
  const header = lines[0].map((h) => h.trim().toLowerCase());
  const idx = (names: string[]) => header.findIndex((h) => names.includes(h));
  const iDate = idx(['date', 'watched on', 'watched_on', 'watched']);
  const iName = idx(['name', 'title']);
  const iYear = idx(['year']);
  const iRating = idx(['rating']);
  if (iDate < 0 || iName < 0) return { rows: [], skipped: lines.length - 1 };

  const rows: ImportRow[] = [];
  let skipped = 0;
  for (const cols of lines.slice(1)) {
    const title = (cols[iName] ?? '').trim();
    const watchedOn = normalizeDate(cols[iDate] ?? '');
    if (!title || !watchedOn) {
      skipped += 1;
      continue;
    }
    const year = iYear >= 0 ? Number.parseInt(cols[iYear] ?? '', 10) : Number.NaN;
    const rawRating = iRating >= 0 ? Number.parseFloat(cols[iRating] ?? '') : Number.NaN;
    rows.push({
      title,
      year: Number.isFinite(year) ? year : null,
      watchedOn,
      // Diary ratings are often half-stars (0.5–5); the tracker stores whole stars 1–5.
      rating: Number.isFinite(rawRating) && rawRating > 0 ? Math.min(5, Math.max(1, Math.round(rawRating))) : null,
    });
  }
  return { rows, skipped };
}

function normalizeDate(value: string): string | null {
  const v = value.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (iso) return v;
  const parsed = new Date(v);
  if (Number.isNaN(parsed.getTime())) return null;
  return formatLocalDay(parsed);
}

function splitCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}


function formatLocalDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
