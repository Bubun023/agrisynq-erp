/**
 * Shared invoice/GST arithmetic. Pure functions - no Supabase/Next imports,
 * so they are unit-testable.
 *
 * Rounding rule: every monetary figure is rounded to 2 decimals at LINE level,
 * and document totals are the sum of the ROUNDED line figures. This guarantees
 * header totals always equal the sum of the printed lines (required for GSTR-1
 * to tie out). For intrastate supply the total GST is rounded first, then
 * split so that CGST + SGST == total GST exactly (odd paise go to SGST).
 */

export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export interface GstSplit {
  cgst: number; cgstRate: number;
  sgst: number; sgstRate: number;
  igst: number; igstRate: number;
}

export function splitGst(taxable: number, gstRate: number, isInterstate: boolean): GstSplit {
  const total = round2((taxable * gstRate) / 100);
  if (isInterstate) {
    return { cgst: 0, cgstRate: 0, sgst: 0, sgstRate: 0, igst: total, igstRate: gstRate };
  }
  const cgst = round2(total / 2);
  const sgst = round2(total - cgst);
  return { cgst, cgstRate: gstRate / 2, sgst, sgstRate: gstRate / 2, igst: 0, igstRate: 0 };
}

export interface LineInput {
  qty: number;
  unitPrice: number;
  discountPercent?: number;
  gstRate: number;
  isInterstate: boolean;
}

export interface LineResult extends GstSplit {
  gross: number;
  discount: number;
  taxable: number;
  lineTotal: number;
}

export function computeLine(i: LineInput): LineResult {
  const gross = round2(i.qty * i.unitPrice);
  const discount = round2((gross * (i.discountPercent ?? 0)) / 100);
  const taxable = round2(gross - discount);
  const g = splitGst(taxable, i.gstRate, i.isInterstate);
  return {
    gross, discount, taxable, ...g,
    lineTotal: round2(taxable + g.cgst + g.sgst + g.igst),
  };
}

export interface DocTotals {
  gross: number; discount: number; taxable: number;
  cgst: number; sgst: number; igst: number;
}

/** Sums already-rounded line results into document totals. */
export function sumLines(lines: ReadonlyArray<Pick<LineResult, "gross" | "discount" | "taxable" | "cgst" | "sgst" | "igst">>): DocTotals {
  const t: DocTotals = { gross: 0, discount: 0, taxable: 0, cgst: 0, sgst: 0, igst: 0 };
  for (const l of lines) {
    t.gross += l.gross; t.discount += l.discount; t.taxable += l.taxable;
    t.cgst += l.cgst; t.sgst += l.sgst; t.igst += l.igst;
  }
  return {
    gross: round2(t.gross), discount: round2(t.discount), taxable: round2(t.taxable),
    cgst: round2(t.cgst), sgst: round2(t.sgst), igst: round2(t.igst),
  };
}

/** B2B / B2C Large / B2C Small classification for GSTR-1 (limit: Rs 2.5 lakh, inter-state B2C). */
export function resolveInvoiceType(
  customerGstin: string | null,
  isInterstate: boolean,
  netAmount: number
): "B2B" | "B2C_LARGE" | "B2C_SMALL" {
  if (customerGstin && customerGstin.length === 15) return "B2B";
  if (isInterstate && netAmount > 250000) return "B2C_LARGE";
  return "B2C_SMALL";
}
