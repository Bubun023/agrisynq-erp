/**
 * Go-live data import: column definitions, CSV templates and row normalisation. Pure functions (unit tested).
 * Master-data columns are named exactly like the form fields of addParty / addProduct / addLocation / addFarmer, so each
 * CSV row is fed through the same validated server action a user would use by hand.
 */
import { parseCsv } from "./csv";

export type ImportEntity = "parties" | "products" | "locations" | "farmers" | "opening_stock" | "opening_parties" | "opening_accounts";
export type ColumnKind = "text" | "number" | "bool" | "enum" | "date";

export interface ImportColumn {
  name: string;
  required?: boolean;
  kind?: ColumnKind;
  /** valid values for enums (case-insensitive in the file, upper-cased on the way in) */
  values?: string[];
  note?: string;
}
export interface ImportEntityDef {
  key: ImportEntity;
  label: string;
  description: string;
  /** master data goes row by row through the normal actions; opening data is all-or-nothing in one transaction */
  atomic: boolean;
  columns: ImportColumn[];
  example: string[];
}

const GST_STATUS = ["REGULAR", "COMPOSITION", "UNREGISTERED", "EXEMPT", "SUSPENDED", "CANCELLED"];
const CATEGORIES = ["FERTILIZER", "PESTICIDE", "SEED", "OTHER", "MICRONUTRIENT", "BIO_FERTILIZER", "PLANT_GROWTH", "WEEDICIDE", "FUNGICIDE", "INSECTICIDE", "RODENTICIDE", "ADJUVANT"];
const LOCATION_TYPES = ["OWN", "CF_DEPOT", "QUARANTINE", "VIRTUAL", "BRANCH_WAREHOUSE", "COMPANY_DEPOT", "THIRD_PARTY", "IN_TRANSIT", "DAMAGED", "EXPIRED", "CUSTOMER_CONSIGNMENT"];

export const IMPORT_ENTITIES: ImportEntityDef[] = [
  {
    key: "locations", label: "Locations / godowns", atomic: false,
    description: "Godowns, shops and depots. Import these first - stock needs a location.",
    columns: [
      { name: "name", required: true }, { name: "code" },
      { name: "location_type", required: true, kind: "enum", values: LOCATION_TYPES },
      { name: "ownership", kind: "enum", values: ["OWN", "CF_AGENT", "COMPANY", "THIRD_PARTY", "GOVERNMENT"], note: "default OWN" },
      { name: "address" }, { name: "state" }, { name: "pincode" }, { name: "gstin_of_location" }, { name: "licence_no" },
      { name: "contact_person" }, { name: "contact_phone" },
    ],
    example: ["Main Godown", "MG", "OWN", "OWN", "Plot 4, MIDC", "Maharashtra", "411019", "", "FERT/2024/118", "Suresh", "9876500011"],
  },
  {
    key: "parties", label: "Customers & suppliers", atomic: false,
    description: "Parties with GSTIN, credit terms and role flags (true/false or yes/no).",
    columns: [
      { name: "name", required: true }, { name: "code" }, { name: "alias" },
      { name: "party_type", required: true, kind: "enum", values: ["CUSTOMER", "SUPPLIER", "CF_AGENT", "BOTH"] },
      { name: "is_customer", kind: "bool" }, { name: "is_supplier", kind: "bool" }, { name: "is_cf_agent", kind: "bool" },
      { name: "gstin" }, { name: "gst_status", kind: "enum", values: GST_STATUS, note: "default UNREGISTERED" }, { name: "pan" },
      { name: "state_code", note: "2-digit GST state code" }, { name: "phone" }, { name: "email" },
      { name: "address" }, { name: "state" }, { name: "pincode" },
      { name: "credit_limit", kind: "number" }, { name: "credit_days", kind: "number" },
      { name: "fms_dealer_id" }, { name: "fms_retailer_id" },
    ],
    example: ["Green Valley Retail", "GVR", "", "CUSTOMER", "yes", "no", "no", "27AAACG2222B1Z2", "REGULAR", "AAACG2222B", "27", "9876543210", "", "Main Road, Pune", "Maharashtra", "411001", "200000", "30", "", ""],
  },
  {
    key: "products", label: "Products", atomic: false,
    description: "Fertilisers, pesticides, seeds with HSN and GST rate.",
    columns: [
      { name: "name", required: true }, { name: "product_code" }, { name: "brand" }, { name: "manufacturer" },
      { name: "category", required: true, kind: "enum", values: CATEGORIES },
      { name: "hsn_code", required: true, note: "4-8 digits" }, { name: "unit_of_measure", required: true, note: "e.g. BAG, KG, LTR" },
      { name: "gst_rate", required: true, kind: "number" }, { name: "tax_status", kind: "enum", values: ["TAXABLE", "EXEMPT", "NIL_RATED", "NON_GST"], note: "default TAXABLE" },
      { name: "mrp", kind: "number" }, { name: "selling_price", kind: "number" }, { name: "purchase_price", kind: "number" },
      { name: "batch_required", kind: "bool" }, { name: "expiry_required", kind: "bool" }, { name: "reorder_level", kind: "number" },
      { name: "fms_product_code" },
    ],
    example: ["Urea 46% (45kg)", "UREA45", "IFFCO", "IFFCO", "FERTILIZER", "3102", "BAG", "5", "TAXABLE", "266.50", "266.50", "240", "yes", "no", "50", "UREA45"],
  },
  {
    key: "farmers", label: "Farmers", atomic: false,
    description: "Farmers for the FMS / iFMS portal. Only the last 4 digits of Aadhaar are accepted.",
    columns: [
      { name: "first_name", required: true }, { name: "last_name" }, { name: "father_spouse_name" },
      { name: "phone", note: "10-digit mobile" }, { name: "village" }, { name: "district" }, { name: "state" }, { name: "pin" },
      { name: "farmer_registration_no" }, { name: "land_category", kind: "enum", values: ["OWNER", "TENANT", "SHARECROPPER", "OTHER"] },
      { name: "cultivated_area_acres", kind: "number" }, { name: "primary_crop" }, { name: "aadhaar_last4" },
      { name: "kyc_status", kind: "enum", values: ["NOT_COLLECTED", "PARTIAL", "COMPLETE", "VERIFIED"] },
    ],
    example: ["Ramesh", "Patil", "Dattu Patil", "9822012345", "Wadgaon", "Pune", "Maharashtra", "412205", "MH-FR-0001", "OWNER", "3.5", "Sugarcane", "4321", "COMPLETE"],
  },
  {
    key: "opening_stock", label: "Opening stock", atomic: true,
    description: "Stock on hand at go-live, by product, godown and batch, valued at cost (excluding GST). Posts as Stock in Hand against Capital.",
    columns: [
      { name: "product", required: true, note: "product code, or exact name" }, { name: "location", required: true, note: "location code, or exact name" },
      { name: "batch_number", required: true }, { name: "qty", required: true, kind: "number" },
      { name: "cost_rate", required: true, kind: "number", note: "cost per unit, excluding GST" },
      { name: "manufacture_date", kind: "date" }, { name: "expiry_date", kind: "date" },
    ],
    example: ["UREA45", "MG", "B2406-01", "250", "240", "2024-06-01", "2027-05-31"],
  },
  {
    key: "opening_parties", label: "Opening party balances", atomic: true,
    description: "What customers owe you and what you owe suppliers on the go-live date. Positive = the normal side (customer owes you / you owe supplier); negative = the opposite (advance).",
    columns: [
      { name: "party", required: true, note: "party code, or exact name" },
      { name: "amount", required: true, kind: "number" },
      { name: "side", kind: "enum", values: ["CUSTOMER", "SUPPLIER"], note: "only needed if the party is both" },
    ],
    example: ["GVR", "45000", "CUSTOMER"],
  },
  {
    key: "opening_accounts", label: "Opening ledger balances", atomic: true,
    description: "Cash, bank, fixed assets, loans and other account balances (not Debtors, Creditors, Stock or Capital - those come from the other sheets).",
    columns: [
      { name: "account_code", required: true }, { name: "debit", kind: "number" }, { name: "credit", kind: "number" },
    ],
    example: ["1001", "25000", ""],
  },
];

export function getEntity(key: string): ImportEntityDef | undefined { return IMPORT_ENTITIES.find((e) => e.key === key); }

export function normaliseHeader(h: string): string {
  return h.replace(/^﻿/, "").replace(/\*/g, "").trim().toLowerCase().replace(/[\s\-/]+/g, "_").replace(/[^a-z0-9_]/g, "");
}

const csvCell = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
export function templateCsv(entity: ImportEntityDef): string {
  return [entity.columns.map((c) => c.name), entity.example].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export type RowIssue = { row: number; message: string };
export type ParsedImport = { rows: Record<string, string>[]; issues: RowIssue[]; unknownColumns: string[]; missingColumns: string[] };

export const MAX_IMPORT_ROWS = 2000;

/** Parses the uploaded file: header mapping, unknown/missing columns, per-row cleanup and validation. `row` numbers are file line numbers. */
export function parseImportFile(text: string, entity: ImportEntityDef): ParsedImport {
  const table = parseCsv(text);
  const out: ParsedImport = { rows: [], issues: [], unknownColumns: [], missingColumns: [] };
  if (table.length === 0) { out.issues.push({ row: 0, message: "The file is empty." }); return out; }
  const headers = table[0].map(normaliseHeader);
  const known = new Set(entity.columns.map((c) => c.name));
  out.unknownColumns = headers.filter((h) => h && !known.has(h));
  out.missingColumns = entity.columns.filter((c) => c.required && !headers.includes(c.name)).map((c) => c.name);
  if (out.missingColumns.length) { out.issues.push({ row: 1, message: `Missing required column(s): ${out.missingColumns.join(", ")}` }); return out; }
  if (table.length - 1 > MAX_IMPORT_ROWS) { out.issues.push({ row: 0, message: `Too many rows (${table.length - 1}); the limit is ${MAX_IMPORT_ROWS} per file - split the file.` }); return out; }

  for (let i = 1; i < table.length; i++) {
    const raw: Record<string, string> = {};
    headers.forEach((h, idx) => { if (known.has(h)) raw[h] = (table[i][idx] ?? "").trim(); });
    const { row, errors } = normaliseRow(entity, raw);
    errors.forEach((message) => out.issues.push({ row: i + 1, message }));
    out.rows.push(row);
  }
  return out;
}

const TRUE = new Set(["true", "yes", "y", "1", "t"]);
const FALSE = new Set(["false", "no", "n", "0", "f", ""]);

export function parseNumber(s: string): number | null {
  const t = s.replace(/[₹,\s]/g, "").replace(/^rs\.?/i, "");
  if (t === "") return null;
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : NaN;
}

/** Accepts YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY. Returns ISO date or null when unreadable. */
export function parseDate(s: string): string | null {
  const t = s.trim();
  let y: number, m: number, d: number, hit: RegExpMatchArray | null;
  if ((hit = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) { y = +hit[1]; m = +hit[2]; d = +hit[3]; }
  else if ((hit = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/))) { d = +hit[1]; m = +hit[2]; y = +hit[3]; }
  else return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

export function normaliseRow(entity: ImportEntityDef, raw: Record<string, string>): { row: Record<string, string>; errors: string[] } {
  const row: Record<string, string> = {};
  const errors: string[] = [];
  for (const c of entity.columns) {
    let v = (raw[c.name] ?? "").trim();
    if (v === "") { if (c.required) errors.push(`${c.name} is required`); row[c.name] = ""; continue; }
    if (c.kind === "bool") {
      const l = v.toLowerCase();
      if (TRUE.has(l)) v = "true"; else if (FALSE.has(l)) v = "false"; else errors.push(`${c.name}: "${v}" is not yes/no`);
    } else if (c.kind === "number") {
      const n = parseNumber(v);
      if (n === null || Number.isNaN(n)) errors.push(`${c.name}: "${v}" is not a number`); else v = String(n);
    } else if (c.kind === "enum") {
      const u = v.toUpperCase().replace(/[\s-]+/g, "_");
      if (c.values && !c.values.includes(u)) errors.push(`${c.name}: "${v}" is not one of ${c.values.join(", ")}`); else v = u;
    } else if (c.kind === "date") {
      const d = parseDate(v);
      if (!d) errors.push(`${c.name}: "${v}" is not a date (use YYYY-MM-DD or DD/MM/YYYY)`); else v = d;
    }
    row[c.name] = v;
  }
  return { row, errors };
}

/** Opening stock / balances need extra cross-field checks that do not need the database. */
export function checkOpeningRow(entity: ImportEntity, row: Record<string, string>): string[] {
  const errs: string[] = [];
  const num = (k: string) => (row[k] === "" ? 0 : Number(row[k]));
  if (entity === "opening_stock") {
    if (num("qty") <= 0) errs.push("qty must be greater than zero");
    if (num("cost_rate") < 0) errs.push("cost_rate cannot be negative");
    if (row.manufacture_date && row.expiry_date && row.expiry_date < row.manufacture_date) errs.push("expiry_date is before manufacture_date");
  } else if (entity === "opening_parties") {
    if (num("amount") === 0) errs.push("amount must not be zero");
  } else if (entity === "opening_accounts") {
    const d = num("debit"), c = num("credit");
    if (d < 0 || c < 0) errs.push("amounts cannot be negative");
    else if ((d > 0) === (c > 0)) errs.push("give either a debit or a credit amount (not both, not neither)");
  }
  return errs;
}
