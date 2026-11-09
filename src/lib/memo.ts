/**
 * Memo-purchase costing. Pure functions - unit tested.
 * MUST match post_memo_purchase() in migration 047:
 *   net  = qty x rate, less percentage discount, then less flat discount (no GST, ever)
 *   cost = net / (paid qty + free qty), rounded to 4 decimals
 * The database recomputes at posting; this module only drives the on-screen preview.
 */
import { round2 } from "./gst";

export interface MemoLineInput {
  qty: number;
  freeQty?: number;
  rate: number;
  discountPercent?: number;
  discountAmount?: number;
}

export interface MemoLineResult {
  gross: number;       // qty x rate
  net: number;         // after discounts
  totalUnits: number;  // paid + free
  unitCost: number;    // net / totalUnits (4 dp)
}

export function round4(n: number): number {
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

/** Returns the result, or an error message when the inputs cannot be costed. */
export function calcMemoLine(i: MemoLineInput): MemoLineResult | { error: string } {
  const free = i.freeQty ?? 0;
  const pct = i.discountPercent ?? 0;
  const flat = i.discountAmount ?? 0;
  if (!(i.qty > 0)) return { error: "Quantity must be greater than 0" };
  if (free < 0) return { error: "Free quantity cannot be negative" };
  if (!(i.rate >= 0)) return { error: "Rate cannot be negative" };
  if (pct < 0 || pct > 100) return { error: "Discount % must be between 0 and 100" };
  if (flat < 0) return { error: "Discount amount cannot be negative" };

  const gross = round2(i.qty * i.rate);
  const net = round2(i.qty * i.rate * (1 - pct / 100) - flat);
  if (net < 0) return { error: "The discount is larger than the value of the goods" };
  const totalUnits = i.qty + free;
  return { gross, net, totalUnits, unitCost: round4(net / totalUnits) };
}

export function isMemoError(r: MemoLineResult | { error: string }): r is { error: string } {
  return "error" in r;
}

/** Value that moves with a stock journal: sum of qty x unit cost of the outgoing batches. */
export function journalOutValue(lines: { qty: number; unitCost: number }[]): number {
  return round2(lines.reduce((s, l) => s + round2(l.qty * l.unitCost), 0));
}

/** Cost per unit of every incoming line = total outgoing value / total incoming quantity (4 dp). */
export function journalInUnitCost(outValue: number, inQty: number): number {
  return inQty > 0 ? round4(outValue / inQty) : 0;
}
