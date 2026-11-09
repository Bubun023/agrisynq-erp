/**
 * Minimal RFC-4180 CSV parser (no dependencies). Pure function - unit tested.
 * - strips a UTF-8 BOM
 * - handles quoted fields containing delimiters, newlines and doubled quotes ("")
 * - accepts \r\n, \n and \r line endings
 * - auto-detects the delimiter (comma, semicolon or tab) from the first line
 * - drops completely empty rows
 */
export function detectDelimiter(firstLine: string): "," | ";" | "\t" {
  const count = (c: string) => {
    let n = 0, inQ = false;
    for (const ch of firstLine) {
      if (ch === '"') inQ = !inQ;
      else if (ch === c && !inQ) n++;
    }
    return n;
  };
  const candidates: [",", ";", "\t"] = [",", ";", "\t"];
  return candidates.reduce((best, c) => (count(c) > count(best) ? c : best), ",");
}

export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, "");
  const firstLine = text.split(/\r\n|\n|\r/, 1)[0] ?? "";
  const delim = detectDelimiter(firstLine);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  const endField = () => { row.push(field); field = ""; };
  const endRow = () => {
    endField();
    if (row.some((c) => c.trim() !== "")) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      endField();
    } else if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      endRow();
    } else if (ch === "\n") {
      endRow();
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) endRow();
  return rows;
}
