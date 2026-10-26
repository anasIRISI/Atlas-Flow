import type { JsonObject } from '@flowforge/shared';

// Small RFC 4180 CSV reader / writer (quotes, escaped quotes, line breaks inside quotes, BOM).

const cellText = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

function quote(text: string, delimiter: string): string {
  return text.includes('"') || text.includes(delimiter) || /[\r\n]/.test(text) || /^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Column names in first-seen order over all rows. */
export function columnsOf(rows: JsonObject[]): string[] {
  return [...new Set(rows.flatMap((row) => Object.keys(row)))];
}

export function toCsv(rows: JsonObject[], options: { delimiter?: string; headerRow?: boolean } = {}): string {
  const delimiter = options.delimiter || ',';
  const columns = columnsOf(rows);
  if (columns.length === 0) return '';
  const lines = rows.map((row) => columns.map((c) => quote(cellText(row[c]), delimiter)).join(delimiter));
  if (options.headerRow !== false) lines.unshift(columns.map((c) => quote(c, delimiter)).join(delimiter));
  return lines.join('\n') + (lines.length ? '\n' : '');
}

/** Guesses the delimiter from the first line (outside quotes): comma, semicolon, tab or pipe. */
export function detectDelimiter(text: string): string {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0, '|': 0 };
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && ch in counts) counts[ch]!++;
  }
  const [best, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]!;
  return count > 0 ? best : ',';
}

/** Splits CSV text into rows of cells. Throws on an unclosed quote. */
export function parseCsvRows(input: string, delimiter?: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const sep = delimiter || detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let wasQuoted = false;
  let line = 1;
  let openedAt = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else {
        if (ch === '\n') line++;
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && cell === '' && !wasQuoted) {
      quoted = true;
      wasQuoted = true;
      openedAt = line;
    } else if (text.startsWith(sep, i)) {
      row.push(cell);
      cell = '';
      wasQuoted = false;
      i += sep.length - 1;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      line++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      wasQuoted = false;
    } else cell += ch;
  }
  if (quoted) throw new Error(`A quote opened on line ${openedAt} is never closed`);
  if (cell !== '' || wasQuoted || row.length) {
    row.push(cell);
    rows.push(row);
  }
  // Blank lines are not rows.
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?$/;

function typed(text: string): string | number | boolean {
  if (NUMBER.test(text) && text.replace(/[-.]/g, '').length <= 15) return Number(text);
  if (text === 'true' || text === 'TRUE') return true;
  if (text === 'false' || text === 'FALSE') return false;
  return text;
}

/**
 * CSV text → objects keyed by the header row (or `{ row: [...] }` without a header row).
 * Numbers and true/false become real values unless `readAsString` is set.
 */
export function parseCsv(text: string, options: { delimiter?: string; headerRow?: boolean; readAsString?: boolean } = {}): JsonObject[] {
  const rows = parseCsvRows(text, options.delimiter);
  const convert = (v: string) => (options.readAsString ? v : typed(v));
  if (options.headerRow === false) return rows.map((r) => ({ row: r.map(convert) }));
  const [header, ...body] = rows;
  if (!header) return [];
  const seen = new Map<string, number>();
  const names = header.map((raw, i) => {
    const base = raw.trim() || `column_${i + 1}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}_${count}`;
  });
  return body.map((r) => {
    const json: JsonObject = {};
    names.forEach((name, i) => (json[name] = convert(r[i] ?? '')));
    return json;
  });
}
