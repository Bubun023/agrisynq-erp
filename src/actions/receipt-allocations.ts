"use server";

import { createClient } from "@/lib/supabase/server";
import { getUserContext, writeAuditLog } from "./context";
import { revalidatePath } from "next/cache";

export type AllocInvoice = { id: string; invoice_number: string; invoice_date: string; due_date: string | null; total: number; outstanding: number; allocated: number };
export type AllocInfo = {
  error?: string;
  receipt?: { id: string; receipt_no: string; type: "RECEIPT" | "PAYMENT"; amount: number; party_name: string };
  invoices: AllocInvoice[];
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** The party's open invoices (sales for a receipt, purchase for a payment) plus what is already allocated on this draft. */
export async function getReceiptAllocationInfo(receiptId: string): Promise<AllocInfo> {
  try {
    if (!UUID.test(receiptId)) return { error: "Receipt not found", invoices: [] };
    const ctx = await getUserContext();
    const supabase = createClient();
    const { data: rc } = await supabase.from("payment_receipts")
      .select("id, receipt_no, receipt_type, party_id, amount, status, party:parties!payment_receipts_party_id_fkey(name)")
      .eq("id", receiptId).eq("tenant_id", ctx.tenantId).maybeSingle();
    if (!rc) return { error: "Receipt not found", invoices: [] };
    if (rc.status !== "DRAFT") return { error: "Only a draft receipt can be allocated", invoices: [] };
    const isReceipt = rc.receipt_type === "RECEIPT";
    const { data: invs, error } = await supabase.from(isReceipt ? "sales_invoices" : "purchase_invoices")
      .select(isReceipt ? "id, invoice_number, invoice_date, due_date, net_receivable, outstanding_amount" : "id, invoice_number, invoice_date, due_date, net_payable, outstanding_amount")
      .eq("tenant_id", ctx.tenantId).eq(isReceipt ? "customer_id" : "supplier_id", rc.party_id).eq("status", "POSTED").gt("outstanding_amount", 0)
      .order("due_date", { ascending: true, nullsFirst: false }).order("invoice_date", { ascending: true });
    if (error) return { error: error.message, invoices: [] };
    const { data: al } = await supabase.from("receipt_allocations").select("invoice_id, allocated_amount").eq("receipt_id", receiptId).eq("tenant_id", ctx.tenantId);
    const mine = new Map((al ?? []).map((a) => [a.invoice_id as string, Number(a.allocated_amount)]));
    const party = rc.party as unknown as { name: string } | { name: string }[] | null;
    return {
      receipt: { id: rc.id, receipt_no: rc.receipt_no, type: rc.receipt_type, amount: Number(rc.amount), party_name: (Array.isArray(party) ? party[0]?.name : party?.name) ?? "" },
      invoices: ((invs ?? []) as unknown as Record<string, unknown>[]).map((i) => ({
        id: i.id as string, invoice_number: i.invoice_number as string, invoice_date: i.invoice_date as string, due_date: (i.due_date as string) ?? null,
        total: Number(isReceipt ? i.net_receivable : i.net_payable), outstanding: Number(i.outstanding_amount), allocated: mine.get(i.id as string) ?? 0,
      })),
    };
  } catch (e) { return { error: e instanceof Error ? e.message : "Could not load", invoices: [] }; }
}

/**
 * Replaces the draft receipt's allocations. Saving an empty list clears them, in which case posting falls back to
 * oldest-first auto-allocation. Any amount not allocated to an invoice stays on the party's account as an advance.
 */
export async function saveReceiptAllocations(receiptId: string, rows: { invoiceId: string; amount: number }[]): Promise<{ success?: boolean; error?: string }> {
  try {
    const info = await getReceiptAllocationInfo(receiptId);
    if (info.error || !info.receipt) return { error: info.error ?? "Receipt not found" };
    const ctx = await getUserContext();
    const clean = rows.filter((r) => r.amount > 0);
    const seen = new Set<string>();
    let total = 0;
    for (const r of clean) {
      if (!UUID.test(r.invoiceId) || seen.has(r.invoiceId)) return { error: "Each invoice can be allocated once" };
      seen.add(r.invoiceId);
      const inv = info.invoices.find((i) => i.id === r.invoiceId);
      if (!inv) return { error: "One of the invoices is not open for this party" };
      if (!Number.isFinite(r.amount)) return { error: "Invalid amount" };
      if (r2(r.amount) > inv.outstanding + 0.001) return { error: `Invoice ${inv.invoice_number}: ${r2(r.amount)} is more than the ${inv.outstanding} still outstanding` };
      total = r2(total + r2(r.amount));
    }
    if (total > info.receipt.amount + 0.001) return { error: `Allocated ${total} is more than the receipt amount ${info.receipt.amount}` };

    const supabase = createClient();
    const del = await supabase.from("receipt_allocations").delete().eq("receipt_id", receiptId).eq("tenant_id", ctx.tenantId);
    if (del.error) return { error: del.error.message };
    if (clean.length) {
      const ins = await supabase.from("receipt_allocations").insert(clean.map((r) => ({
        tenant_id: ctx.tenantId, receipt_id: receiptId, invoice_type: info.receipt!.type === "RECEIPT" ? "SALES_INVOICE" : "PURCHASE_INVOICE",
        invoice_id: r.invoiceId, allocated_amount: r2(r.amount),
      })));
      if (ins.error) return { error: ins.error.message };
    }
    await writeAuditLog({ ctx, action: "UPDATE", tableName: "receipt_allocations", recordId: receiptId, newValues: { allocated: total, invoices: clean.length } });
    revalidatePath("/accounting/receipts");
    return { success: true };
  } catch (e) { return { error: e instanceof Error ? e.message : "Could not save" }; }
}
