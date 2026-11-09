"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { calcMemoLine, isMemoError } from "@/lib/memo";
import { getUserContext, writeAuditLog } from "./context";

// ─── Types ────────────────────────────────────────────────────

export interface MemoLine {
  id: string;
  line_no: number;
  product_id: string;
  product: { id: string; name: string; product_code: string | null } | null;
  batch_id: string | null;
  batch_number: string | null;
  unit_of_measure: string;
  qty: number;
  free_qty: number;
  rate: number;
  discount_percent: number;
  discount_amount: number;
  net_amount: number | null;
  unit_cost: number | null;
  total_units: number;
  settled_units: number;
  returned_units: number;
  waived_units: number;
  pending_units: number;
}

export interface MemoPurchase {
  id: string;
  memo_no: string;
  memo_date: string;
  status: "DRAFT" | "POSTED" | "CANCELLED";
  supplier_ref: string;
  narration: string | null;
  total_value: number;
  supplier_id: string;
  received_at_location: string;
  supplier: { id: string; name: string } | null;
  location: { id: string; name: string } | null;
  lines: MemoLine[];
}

export interface PendingMemoLine {
  memo_id: string;
  memo_no: string;
  memo_date: string;
  supplier_id: string;
  supplier_name: string;
  supplier_ref: string;
  received_at_location: string;
  location_name: string;
  memo_line_id: string;
  line_no: number;
  product_id: string;
  product_name: string;
  batch_id: string | null;
  unit_of_measure: string;
  total_units: number;
  pending_units: number;
  unit_cost: number;
  pending_value: number;
  age_days: number;
}

export interface PendingSupplier {
  supplier_id: string;
  supplier_name: string;
  open_memos: number;
  pending_units: number;
  pending_value: number;
  oldest_memo_date: string;
  oldest_age_days: number;
}

export interface MatchInvoiceLine {
  id: string;
  line_no: number;
  product_id: string;
  product_name: string;
  units: number;
  unmatched_units: number;
  unit_cost: number | null;
}
export interface MatchInvoice {
  id: string;
  invoice_number: string;
  invoice_date: string;
  supplier_invoice_no: string | null;
  lines: MatchInvoiceLine[];
}

export interface JournalSuggestion {
  outBatchId: string;
  outProductName: string;
  inProductId: string;
  inProductName: string;
  qty: number;
  locationId: string;
}

// ─── Reads ────────────────────────────────────────────────────

export async function getMemoPurchases(): Promise<MemoPurchase[]> {
  const supabase = createClient();
  const ctx = await getUserContext();
  const { data, error } = await supabase
    .from("memo_purchases")
    .select(`
      *,
      supplier:parties!memo_purchases_supplier_id_fkey(id, name),
      location:locations!memo_purchases_received_at_location_fkey(id, name),
      lines:memo_purchase_lines(*, product:products(id, name, product_code))
    `)
    .eq("tenant_id", ctx.tenantId)
    .eq("organisation_id", ctx.organisationId)
    .order("created_at", { ascending: false })
    .limit(300);
  if (error) throw new Error(`Memo purchases error: ${error.message}`);
  return ((data ?? []) as unknown as MemoPurchase[]).map((m) => ({
    ...m,
    lines: [...m.lines].sort((a, b) => a.line_no - b.line_no),
  }));
}

export async function getPendingMemoLines(): Promise<PendingMemoLine[]> {
  const supabase = createClient();
  const ctx = await getUserContext();
  const { data, error } = await supabase.from("vw_memo_pending").select("*")
    .eq("organisation_id", ctx.organisationId).order("memo_date").limit(2000);
  if (error) throw new Error(`Pending memo lines error: ${error.message}`);
  return (data ?? []) as PendingMemoLine[];
}

export async function getPendingBySupplier(): Promise<PendingSupplier[]> {
  const supabase = createClient();
  const ctx = await getUserContext();
  const { data, error } = await supabase.from("vw_memo_pending_by_supplier").select("*")
    .eq("organisation_id", ctx.organisationId).order("oldest_age_days", { ascending: false });
  if (error) throw new Error(`Pending suppliers error: ${error.message}`);
  return (data ?? []) as PendingSupplier[];
}

/** Posted invoices of one supplier (last 12 months) with how much of each line is still unmatched. */
export async function getMatchCandidates(supplierId: string): Promise<MatchInvoice[]> {
  const supabase = createClient();
  const ctx = await getUserContext();
  const since = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("purchase_invoices")
    .select(`id, invoice_number, invoice_date, supplier_invoice_no,
             lines:purchase_invoice_lines(id, line_no, product_id, received_qty, free_qty, landing_cost_per_unit, product:products(id, name))`)
    .eq("tenant_id", ctx.tenantId).eq("organisation_id", ctx.organisationId)
    .eq("supplier_id", supplierId).eq("status", "POSTED").gte("invoice_date", since)
    .order("invoice_date", { ascending: false }).limit(200);
  if (error) throw new Error(`Supplier invoices error: ${error.message}`);

  type Raw = { id: string; invoice_number: string; invoice_date: string; supplier_invoice_no: string | null;
    lines: { id: string; line_no: number; product_id: string; received_qty: number; free_qty: number | null; landing_cost_per_unit: number | null;
             product: { id: string; name: string } | { id: string; name: string }[] | null }[] };
  const invoices = (data ?? []) as unknown as Raw[];
  const lineIds = invoices.flatMap((i) => i.lines.map((l) => l.id));
  const used = new Map<string, number>();
  if (lineIds.length) {
    const { data: m, error: mErr } = await supabase.from("memo_settlement_lines").select("invoice_line_id, units")
      .eq("tenant_id", ctx.tenantId).in("invoice_line_id", lineIds);
    if (mErr) throw new Error(mErr.message);
    for (const r of m ?? []) used.set(r.invoice_line_id, (used.get(r.invoice_line_id) ?? 0) + Number(r.units));
  }
  return invoices.map((i) => ({
    id: i.id, invoice_number: i.invoice_number, invoice_date: i.invoice_date, supplier_invoice_no: i.supplier_invoice_no,
    lines: i.lines.sort((a, b) => a.line_no - b.line_no).map((l) => {
      const units = Number(l.received_qty) + Number(l.free_qty ?? 0);
      const prod = Array.isArray(l.product) ? l.product[0] : l.product;
      return { id: l.id, line_no: l.line_no, product_id: l.product_id, product_name: prod?.name ?? "?", units,
               unmatched_units: Math.max(0, units - (used.get(l.id) ?? 0)), unit_cost: l.landing_cost_per_unit };
    }),
  })).filter((i) => i.lines.some((l) => l.unmatched_units > 0));
}

// ─── Create / post a memo ─────────────────────────────────────

const LineSchema = z.object({
  product_id:       z.string().uuid("Select a product"),
  qty:              z.number().positive("Quantity must be greater than 0"),
  free_qty:         z.number().min(0).default(0),
  rate:             z.number().min(0, "Rate cannot be negative"),
  discount_percent: z.number().min(0).max(100).default(0),
  discount_amount:  z.number().min(0).default(0),
  batch_number:     z.string().trim().max(100).optional().or(z.literal("")),
  manufacture_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
  expiry_date:      z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
});
const MemoSchema = z.object({
  supplier_id:          z.string().uuid("Select the supplier"),
  received_at_location: z.string().uuid("Select the receiving location"),
  memo_date:            z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the receipt date"),
  supplier_ref:         z.string().trim().min(1, "The supplier's challan / reference number is required").max(100),
  narration:            z.string().trim().max(500).optional().or(z.literal("")),
  lines:                z.array(LineSchema).min(1, "Add at least one line"),
});
export type CreateMemoInput = z.input<typeof MemoSchema>;

export async function createMemoPurchase(input: CreateMemoInput) {
  const p = MemoSchema.safeParse(input);
  if (!p.success) return { success: false as const, error: p.error.issues[0]?.message ?? "Invalid input" };
  const d = p.data;

  for (let i = 0; i < d.lines.length; i++) {
    const l = d.lines[i];
    const r = calcMemoLine({ qty: l.qty, freeQty: l.free_qty, rate: l.rate, discountPercent: l.discount_percent, discountAmount: l.discount_amount });
    if (isMemoError(r)) return { success: false as const, error: `Line ${i + 1}: ${r.error}` };
  }

  const supabase = createClient();
  const ctx = await getUserContext();

  const { data: prods, error: pErr } = await supabase.from("products").select("id, unit_of_measure")
    .eq("tenant_id", ctx.tenantId).eq("organisation_id", ctx.organisationId).in("id", d.lines.map((l) => l.product_id));
  if (pErr) return { success: false as const, error: pErr.message };
  const uom = new Map((prods ?? []).map((x) => [x.id, x.unit_of_measure as string]));
  if (d.lines.some((l) => !uom.has(l.product_id))) return { success: false as const, error: "A selected product was not found" };

  // MEMO-<year>-<nnnnn>, retried if two people save at once
  const year = d.memo_date.slice(0, 4);
  let header: { id: string; memo_no: string } | null = null;
  let lastError = "";
  for (let attempt = 0; attempt < 3 && !header; attempt++) {
    const { data: last } = await supabase.from("memo_purchases").select("memo_no")
      .eq("tenant_id", ctx.tenantId).eq("organisation_id", ctx.organisationId).like("memo_no", `MEMO-${year}-%`)
      .order("memo_no", { ascending: false }).limit(1);
    const n = last?.[0] ? Number(last[0].memo_no.split("-")[2]) + 1 : 1;
    const memoNo = `MEMO-${year}-${String(n).padStart(5, "0")}`;
    const { data, error } = await supabase.from("memo_purchases").insert({
      tenant_id: ctx.tenantId, organisation_id: ctx.organisationId, branch_id: ctx.branchId,
      memo_no: memoNo, memo_date: d.memo_date, supplier_id: d.supplier_id, received_at_location: d.received_at_location,
      supplier_ref: d.supplier_ref, narration: d.narration || null, status: "DRAFT", created_by: ctx.userId,
    }).select("id, memo_no").single();
    if (data) header = data; else lastError = error?.message ?? "Could not create the memo";
  }
  if (!header) return { success: false as const, error: lastError };

  const { error: lErr } = await supabase.from("memo_purchase_lines").insert(d.lines.map((l, i) => ({
    tenant_id: ctx.tenantId, memo_id: header!.id, line_no: i + 1, product_id: l.product_id,
    batch_number: l.batch_number || null, manufacture_date: l.manufacture_date || null, expiry_date: l.expiry_date || null,
    qty: l.qty, free_qty: l.free_qty, unit_of_measure: uom.get(l.product_id)!, rate: l.rate,
    discount_percent: l.discount_percent, discount_amount: l.discount_amount,
  })));
  if (lErr) {
    await supabase.from("memo_purchases").update({ status: "CANCELLED" }).eq("id", header.id);
    return { success: false as const, error: lErr.message };
  }

  await writeAuditLog({ ctx, action: "INSERT", tableName: "memo_purchases", recordId: header.id, newValues: { memo_no: header.memo_no } });
  revalidatePath("/purchases/memo");
  return { success: true as const, memoNo: header.memo_no };
}

export async function postMemoPurchase(memoId: string) {
  const supabase = createClient();
  const ctx = await getUserContext();
  const { error } = await supabase.rpc("post_memo_purchase", { p_memo_id: memoId });
  if (error) return { success: false as const, error: error.message };
  await writeAuditLog({ ctx, action: "POST", tableName: "memo_purchases", recordId: memoId, newValues: { status: "POSTED" } });
  revalidatePath("/purchases/memo"); revalidatePath("/inventory/ledger"); revalidatePath("/inventory/batches");
  return { success: true as const };
}

export async function cancelMemoDraft(memoId: string) {
  const supabase = createClient();
  const ctx = await getUserContext();
  const { data, error } = await supabase.from("memo_purchases").update({ status: "CANCELLED" })
    .eq("id", memoId).eq("tenant_id", ctx.tenantId).eq("status", "DRAFT").select("id");
  if (error) return { success: false as const, error: error.message };
  if (!data?.length) return { success: false as const, error: "Only a draft memo can be cancelled" };
  await writeAuditLog({ ctx, action: "CANCEL", tableName: "memo_purchases", recordId: memoId });
  revalidatePath("/purchases/memo");
  return { success: true as const };
}

// ─── Match to the supplier's invoice ──────────────────────────

const SettleSchema = z.object({
  memoId: z.string().uuid(),
  invoiceId: z.string().uuid(),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
  lines: z.array(z.object({
    memoLineId: z.string().uuid(), invoiceLineId: z.string().uuid(), units: z.number().positive("Units must be greater than 0"),
  })).min(1, "Choose at least one line to match"),
});
export type SettleInput = z.infer<typeof SettleSchema>;

/**
 * Matches memo lines to lines of the supplier's posted invoice. Returns stock-journal suggestions for every
 * line where the supplier billed a DIFFERENT product from the one physically received (A received, B billed):
 * stock out the billed product (B), stock in the received product (A).
 */
export async function settleMemo(input: SettleInput) {
  const p = SettleSchema.safeParse(input);
  if (!p.success) return { success: false as const, error: p.error.issues[0]?.message ?? "Invalid input" };
  const d = p.data;

  const supabase = createClient();
  const ctx = await getUserContext();
  const { data, error } = await supabase.rpc("settle_memo_with_invoice", {
    p_memo_id: d.memoId, p_invoice_id: d.invoiceId, p_notes: d.notes || null,
    p_lines: d.lines.map((l) => ({ memo_line_id: l.memoLineId, invoice_line_id: l.invoiceLineId, units: l.units })),
  });
  if (error) return { success: false as const, error: error.message };
  const settlement = data as { id: string };

  await writeAuditLog({ ctx, action: "MEMO_SETTLE", tableName: "memo_settlements", recordId: settlement.id,
    newValues: { memo_id: d.memoId, invoice_id: d.invoiceId, lines: d.lines.length } });

  // suggestions for the stock journal
  const suggestions: JournalSuggestion[] = [];
  const { data: sl } = await supabase.from("memo_settlement_lines")
    .select(`units_on_hand,
             memo_line:memo_purchase_lines(product_id, product:products(name)),
             invoice_line:purchase_invoice_lines(product_id, batch_id, product:products(name))`)
    .eq("settlement_id", settlement.id);
  const { data: inv } = await supabase.from("purchase_invoices").select("received_at_location").eq("id", d.invoiceId).single();
  type One<T> = T | T[] | null;
  const first = <T,>(v: One<T>) => (Array.isArray(v) ? v[0] : v);
  for (const r of (sl ?? []) as unknown as {
    units_on_hand: number;
    memo_line: One<{ product_id: string; product: One<{ name: string }> }>;
    invoice_line: One<{ product_id: string; batch_id: string | null; product: One<{ name: string }> }>;
  }[]) {
    const ml = first(r.memo_line), il = first(r.invoice_line);
    if (!ml || !il || !il.batch_id || !inv) continue;
    if (ml.product_id !== il.product_id && Number(r.units_on_hand) > 0) {
      suggestions.push({
        outBatchId: il.batch_id, outProductName: first(il.product)?.name ?? "?",
        inProductId: ml.product_id, inProductName: first(ml.product)?.name ?? "?",
        qty: Number(r.units_on_hand), locationId: inv.received_at_location,
      });
    }
  }

  revalidatePath("/purchases/memo"); revalidatePath("/inventory/ledger"); revalidatePath("/accounting/trial-balance");
  return { success: true as const, settlementId: settlement.id, invoiceId: d.invoiceId, suggestions };
}

const CloseSchema = z.object({
  memoLineId: z.string().uuid(),
  units: z.number().positive("Units must be greater than 0"),
  mode: z.enum(["RETURN", "WAIVED"]),
  reason: z.string().trim().min(3, "Give a reason").max(500),
});
export async function closeMemoUnits(input: z.infer<typeof CloseSchema>) {
  const p = CloseSchema.safeParse(input);
  if (!p.success) return { success: false as const, error: p.error.issues[0]?.message ?? "Invalid input" };
  const supabase = createClient();
  const ctx = await getUserContext();
  const { error } = await supabase.rpc("close_memo_units", {
    p_memo_line_id: p.data.memoLineId, p_units: p.data.units, p_mode: p.data.mode, p_reason: p.data.reason,
  });
  if (error) return { success: false as const, error: error.message };
  await writeAuditLog({ ctx, action: p.data.mode === "RETURN" ? "MEMO_RETURN" : "MEMO_WAIVE", tableName: "memo_purchase_lines",
    recordId: p.data.memoLineId, reason: p.data.reason, newValues: { units: p.data.units } });
  revalidatePath("/purchases/memo"); revalidatePath("/inventory/ledger"); revalidatePath("/accounting/trial-balance");
  return { success: true as const };
}
