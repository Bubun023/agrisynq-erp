/**
 * Maps the columns of an FMS/iFMS portal export to our import format.
 * Pure functions - unit tested. Header names differ between portal reports,
 * so headers are normalised (lower-case, letters/digits only) and matched
 * against a list of known aliases.
 */

export type FmsField = "pos_id" | "date" | "qty" | "subsidy" | "farmer" | "product_code" | "ack";

const ALIASES: Record<FmsField, string[]> = {
  pos_id: ["postransactionid", "postxnid", "postransactionno", "transactionid", "transactionno", "txnid", "txnno", "posid", "posbillno", "posbillnumber"],
  date: ["date", "transactiondate", "txndate", "saledate", "billdate", "dateoftransaction"],
  qty: ["qty", "quantity", "quantitysold", "qtysold", "salequantity", "totalquantity"],
  subsidy: ["subsidy", "subsidyamount", "subsidyamt", "totalsubsidy", "subsidyvalue", "subsidyclaimed"],
  farmer: ["farmer", "farmername", "buyer", "buyername", "customername", "beneficiary", "beneficiaryname"],
  product_code: ["productcode", "fmsproductcode", "productid", "fertilizercode", "skucode"],
  ack: ["ack", "ackno", "acknowledgement", "acknowledgementno", "acknowledgmentno", "acknowledgmentnumber", "referenceno", "refno"],
};

export const REQUIRED_FIELDS: FmsField[] = ["pos_id", "qty", "subsidy"];

export const FIELD_LABEL: Record<FmsField, string> = {
  pos_id: "PoS transaction ID",
  date: "Transaction date",
  qty: "Quantity",
  subsidy: "Subsidy amount",
  farmer: "Farmer name",
  product_code: "Product code",
  ack: "Acknowledgement no",
};

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]/g, "");

export interface ColumnMap {
  map: Partial<Record<FmsField, number>>;
  missing: FmsField[];          // required fields that could not be found
}

export function mapColumns(headers: string[]): ColumnMap {
  const normalised = headers.map(norm);
  const map: Partial<Record<FmsField, number>> = {};
  (Object.keys(ALIASES) as FmsField[]).forEach((field) => {
    const idx = normalised.findIndex((h) => ALIASES[field].includes(h));
    if (idx >= 0) map[field] = idx;
  });
  return { map, missing: REQUIRED_FIELDS.filter((f) => map[f] === undefined) };
}

/** "1,234.50", "₹ 1,234.50", "Rs. 12" -> number; anything unparseable -> NaN. */
export function parseNumber(raw: string): number {
  const s = raw.replace(/[₹,\s]|rs\.?/gi, "");
  if (s === "") return NaN;
  if (!/^-?\d+(\.\d+)?$/.test(s)) return NaN;
  return Number(s);
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY, DD-Mon-YYYY -> ISO date, or null. */
export function parseDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  let y: number, m: number, d: number;
  let r: RegExpMatchArray | null;
  if ((r = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ].*)?$/))) { y = +r[1]; m = +r[2]; d = +r[3]; }
  else if ((r = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/))) { d = +r[1]; m = +r[2]; y = +r[3]; }
  else if ((r = s.match(/^(\d{1,2})[\s\-]([A-Za-z]{3})[a-z]*[\s\-,]+(\d{4})$/))) {
    d = +r[1]; m = MONTHS.indexOf(r[2].toLowerCase()) + 1; y = +r[3];
    if (m === 0) return null;
  } else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export interface ImportLine {
  pos_id: string;
  date?: string;
  farmer?: string;
  product_code?: string;
  qty: number;
  subsidy: number;
  ack?: string;
}

export interface BuildResult {
  lines: ImportLine[];
  errors: { row: number; message: string }[];   // row = 1-based line number in the file (header = 1)
}

/** rows[0] must be the header row. Numbers that cannot be parsed are reported, never guessed. */
export function buildLines(rows: string[][], cm: ColumnMap): BuildResult {
  const lines: ImportLine[] = [];
  const errors: BuildResult["errors"] = [];
  const cell = (r: string[], f: FmsField) => (cm.map[f] === undefined ? "" : (r[cm.map[f]!] ?? "").trim());

  rows.slice(1).forEach((r, i) => {
    const rowNo = i + 2;
    const qty = parseNumber(cell(r, "qty"));
    const subsidy = parseNumber(cell(r, "subsidy"));
    if (Number.isNaN(qty)) { errors.push({ row: rowNo, message: `Quantity "${cell(r, "qty")}" is not a number` }); return; }
    if (Number.isNaN(subsidy)) { errors.push({ row: rowNo, message: `Subsidy "${cell(r, "subsidy")}" is not a number` }); return; }
    if (qty < 0 || subsidy < 0) { errors.push({ row: rowNo, message: "Negative quantity or subsidy" }); return; }

    const rawDate = cell(r, "date");
    const date = rawDate ? parseDate(rawDate) : null;
    if (rawDate && !date) { errors.push({ row: rowNo, message: `Date "${rawDate}" is not recognised` }); return; }

    lines.push({
      pos_id: cell(r, "pos_id"),
      date: date ?? undefined,
      farmer: cell(r, "farmer") || undefined,
      product_code: cell(r, "product_code") || undefined,
      qty,
      subsidy,
      ack: cell(r, "ack") || undefined,
    });
  });
  return { lines, errors };
}
