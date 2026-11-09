"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getUserContext, writeAuditLog } from "./context";

export interface StockJournalRow {
  id: string;
  journal_no: string;
  journal_date: string;
  reason: string;
  total_value: number;
  location: { id: string; name: string } | null;
  lines: { id: string; direction: "OUT" | "IN"; qty: number; unit_cost: number; value: number;
           product: { name: string } | null; batch: { batch_number: string } | null }[];
}

export interface JournalStockBatch {
  batch_id: string;
  batch_number: string;
  product_id: string;
  product_name: string;
  location_id: string;
  qty: number;
  unit_cost: number;
  expiry_date: string | null;
}

export async function getStockJournals(): Promise<StockJournalRow[]> {
  const supabase = createClient();
  const ctx = await getUserContext();
  const { data, error } = await supabase.from("stock_journals")
    .select(`id, journal_no, journal_date, reason, total_value,
             location:locations(id, name),
             lines:stock_journal_lines(id, direction, qty, unit_cost, value, product:products(name), batch:batch_register(batch_number))`)
    .eq("tenant_id", ctx.tenantId).eq("organisation_id", ctx.organisationId)
    .order("created_at", { ascending: false }).limit(300);
  if (error) throw new Error(`Stock journals error: ${error.message}`);
  return (data ?? []) as unknown as StockJournalRow[];
}

/** Everything the journal form needs: locations, products, and batches that actually have stock (per location). */
export async function getJournalLookups() {
  const supabase = createClient();
  const ctx = await getUserContext();
  const [locs, prods, bal] = await Promise.all([
    supabase.from("locations").select("id, name").eq("tenant_id", ctx.tenantId).eq("organisation_id", ctx.organisationId).eq("is_active", true).order("name"),
    supabase.from("products").select("id, name, product_code").eq("tenant_id", ctx.tenantId).eq("organisation_id", ctx.organisationId).eq("is_active", true).order("name"),
    supabase.from("stock_balance").select("batch_id, location_id, product_id, balance_qty")
      .eq("tenant_id", ctx.tenantId).eq("organisation_id", ctx.organisationId).gt("balance_qty", 0).not("batch_id", "is", null).limit(5000),
  ]);
  if (locs.error) throw new Error(locs.error.message);
  if (prods.error) throw new Error(prods.error.message);
  if (bal.error) throw new Error(bal.error.message);

  const batchIds = Array.from(new Set((bal.data ?? []).map((b) => b.batch_id as string)));
  const batches = new Map<string, { batch_number: string; unit_cost: number; expiry_date: string | null }>();
  if (batchIds.length) {
    const { data, error } = await supabase.from("batch_register")
      .select("id, batch_number, landing_cost_per_unit, purchase_rate, expiry_date").in("id", batchIds);
    if (error) throw new Error(error.message);
    for (const b of data ?? []) batches.set(b.id, { batch_number: b.batch_number, unit_cost: Number(b.landing_cost_per_unit ?? b.purchase_rate ?? 0), expiry_date: b.expiry_date });
  }
  const names = new Map((prods.data ?? []).map((p) => [p.id, p.name as string]));
  const stock: JournalStockBatch[] = (bal.data ?? []).flatMap((r) => {
    const b = batches.get(r.batch_id as string);
    return b ? [{ batch_id: r.batch_id as string, batch_number: b.batch_number, product_id: r.product_id as string,
      product_name: names.get(r.product_id as string) ?? "?", location_id: r.location_id as string,
      qty: Number(r.balance_qty), unit_cost: b.unit_cost, expiry_date: b.expiry_date }] : [];
  });
  return { locations: locs.data ?? [], products: prods.data ?? [], stock };
}

const JournalSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter the journal date"),
  locationId: z.string().uuid("Select the location"),
  reason: z.string().trim().min(3, "Give a reason for the journal").max(500),
  out: z.array(z.object({ batchId: z.string().uuid("Select the batch going out"), qty: z.number().positive("Quantities must be greater than 0") }))
    .min(1, "Add at least one product going out"),
  in: z.array(z.object({
    productId: z.string().uuid("Select the product coming in"), qty: z.number().positive("Quantities must be greater than 0"),
    batchNumber: z.string().trim().max(100).optional().or(z.literal("")),
    manufactureDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
    expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal("")),
  })).min(1, "Add at least one product coming in"),
  memoSettlementId: z.string().uuid().optional(),
  purchaseInvoiceId: z.string().uuid().optional(),
});
export type StockJournalInput = z.infer<typeof JournalSchema>;

export async function createStockJournal(input: StockJournalInput) {
  const p = JournalSchema.safeParse(input);
  if (!p.success) return { success: false as const, error: p.error.issues[0]?.message ?? "Invalid input" };
  const d = p.data;

  const supabase = createClient();
  const ctx = await getUserContext();
  const { data, error } = await supabase.rpc("post_stock_journal", {
    p_organisation_id: ctx.organisationId, p_date: d.date, p_location_id: d.locationId, p_reason: d.reason,
    p_out: d.out.map((o) => ({ batch_id: o.batchId, qty: o.qty })),
    p_in: d.in.map((i) => ({ product_id: i.productId, qty: i.qty, batch_number: i.batchNumber || null,
      manufacture_date: i.manufactureDate || null, expiry_date: i.expiryDate || null })),
    p_memo_settlement_id: d.memoSettlementId ?? null,
    p_purchase_invoice_id: d.purchaseInvoiceId ?? null,
  });
  if (error) return { success: false as const, error: error.message };

  const j = data as { id: string; journal_no: string; total_value: number };
  await writeAuditLog({ ctx, action: "STOCK_JOURNAL", tableName: "stock_journals", recordId: j.id, reason: d.reason,
    newValues: { journal_no: j.journal_no, total_value: j.total_value } });
  revalidatePath("/inventory/journals"); revalidatePath("/inventory/ledger"); revalidatePath("/inventory/batches"); revalidatePath("/purchases/memo");
  return { success: true as const, journalNo: j.journal_no };
}
