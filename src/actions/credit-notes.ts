"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getUserContext, writeAuditLog } from "./context";
import { computeLine, sumLines, resolveInvoiceType, round2 } from "@/lib/gst";

const CNLineSchema = z.object({
  product_id:     z.string().uuid(),
  original_line_id: z.string().uuid().optional().or(z.literal("")),
  hsn_code:       z.string().min(1),
  batch_id:       z.string().uuid().optional().or(z.literal("")),
  return_qty:     z.number().min(0.001),
  unit_of_measure:z.string().min(1),
  unit_price:     z.number().min(0),
  gst_rate:       z.number().min(0).max(28).default(0),
});

export type CNFormState = {
  success?: boolean; error?: string;
  fieldErrors?: Record<string, string[]>;
  cnId?: string; cnNumber?: string;
};

// ─── Create Credit Note (DRAFT) ──────────────────────────────
export async function createCreditNote(_prev: CNFormState, formData: FormData): Promise<CNFormState> {
  try {
    const supabase = createClient();
    const ctx = await getUserContext();

    const originalInvoiceId = formData.get("original_invoice_id") as string;
    if (!originalInvoiceId) return { error: "Original invoice is required." };

    // Validate the original invoice exists, is POSTED, and belongs to this tenant
    const { data: origInv, error: origErr } = await supabase.from("sales_invoices")
      .select("id, invoice_number, status, customer_id, customer_name, customer_gstin, net_receivable, is_interstate")
      .eq("id", originalInvoiceId).eq("tenant_id", ctx.tenantId).single();
    if (origErr || !origInv) return { error: "Original invoice not found or not accessible." };
    if (origInv.status !== "POSTED") return { error: "Credit notes can only be issued against POSTED invoices." };

    const linesJson = formData.get("lines") as string;
    let rawLines: unknown[];
    try { rawLines = JSON.parse(linesJson); } catch { return { error: "Invalid line items." }; }
    if (!Array.isArray(rawLines) || rawLines.length === 0) return { error: "At least one line required." };
    const parsedLines = z.array(CNLineSchema).safeParse(rawLines);
    if (!parsedLines.success) return { error: parsedLines.error.issues[0]?.message };
    const lines = parsedLines.data;

    const isInterstate = origInv.is_interstate as boolean;
    const calcs = lines.map((l) => computeLine({
      qty: l.return_qty, unitPrice: l.unit_price, gstRate: l.gst_rate, isInterstate,
    }));
    const tot = sumLines(calcs);
    const totalTaxable = tot.taxable, totalCgst = tot.cgst, totalSgst = tot.sgst, totalIgst = tot.igst;

    const computedLines = lines.map((l, i) => {
      const c = calcs[i];
      return {
        tenant_id: ctx.tenantId, line_no: i + 1,
        original_line_id: l.original_line_id || null,
        product_id: l.product_id, hsn_code: l.hsn_code,
        batch_id: l.batch_id || null,
        return_qty: l.return_qty, unit_of_measure: l.unit_of_measure,
        unit_price: l.unit_price,
        taxable_amount: c.taxable,
        gst_rate: l.gst_rate,
        cgst_amount: c.cgst,
        sgst_amount: c.sgst,
        igst_amount: c.igst,
        line_total: c.lineTotal,
      };
    });

    const totalAmount = round2(totalTaxable + totalCgst + totalSgst + totalIgst);

    // Guard: CN total cannot exceed original invoice amount
    if (totalAmount > (origInv.net_receivable as number) + 0.01) {
      return { error: `Credit note total (₹${totalAmount.toFixed(2)}) cannot exceed original invoice amount (₹${(origInv.net_receivable as number).toFixed(2)}).` };
    }

    const { data: cnNumData } = await supabase.rpc("generate_cn_number", {
      p_tenant_id: ctx.tenantId, p_org_id: ctx.organisationId,
    });

    const { data: cn, error: cnErr } = await supabase.from("credit_notes").insert([{
      tenant_id: ctx.tenantId, organisation_id: ctx.organisationId, branch_id: ctx.branchId,
      credit_note_number:  cnNumData as string,
      credit_note_date:    (formData.get("credit_note_date") as string) || new Date().toISOString().split("T")[0],
      reason:              formData.get("reason") as string || "RETURN_OF_GOODS",
      reason_detail:       formData.get("reason_detail") as string || null,
      original_invoice_id: originalInvoiceId,
      customer_id:         origInv.customer_id,
      customer_name:       origInv.customer_name,
      customer_gstin:      origInv.customer_gstin,
      goods_returned:      formData.get("goods_returned") !== "false",
      return_to_location:  formData.get("return_to_location") as string || null,
      taxable_amount:      Math.round(totalTaxable * 100) / 100,
      cgst_amount:         Math.round(totalCgst * 100) / 100,
      sgst_amount:         Math.round(totalSgst * 100) / 100,
      igst_amount:         Math.round(totalIgst * 100) / 100,
      total_amount:        Math.round(totalAmount * 100) / 100,
      status: "DRAFT", created_by: ctx.userId,
    }]).select("id, credit_note_number").single();

    if (cnErr || !cn) throw new Error(cnErr?.message ?? "Failed to create credit note.");

    const lineInserts = computedLines.map((l) => ({ ...l, credit_note_id: cn.id }));
    const { error: clErr } = await supabase.from("credit_note_lines").insert(lineInserts);
    if (clErr) throw new Error("Credit note saved but lines failed: " + clErr.message);

    await writeAuditLog({ ctx, action: "INSERT", tableName: "credit_notes", recordId: cn.id,
      newValues: { cn_number: cn.credit_note_number, original_invoice_id: originalInvoiceId, total_amount: totalAmount } });
    revalidatePath("/sales/credit-notes");
    return { success: true, cnId: cn.id, cnNumber: cn.credit_note_number };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : "Failed to create credit note." };
  }
}

// ─── Post Credit Note ─────────────────────────────────────────
export async function postCreditNote(cnId: string): Promise<CNFormState> {
  try {
    const supabase = createClient();
    const ctx = await getUserContext();

    const { data: cn, error: fetchErr } = await supabase.from("credit_notes")
      .select(`id, credit_note_number, status, goods_returned, return_to_location,
               credit_note_lines(product_id, batch_id, return_qty, unit_of_measure, unit_price,
                                  gst_rate, cgst_amount, sgst_amount, igst_amount)`)
      .eq("id", cnId).eq("tenant_id", ctx.tenantId).single();

    if (fetchErr || !cn) throw new Error("Credit note not found.");
    if (cn.status !== "DRAFT") throw new Error("Only DRAFT credit notes can be posted.");

    // If goods were returned, reverse the stock movement
    if (cn.goods_returned && cn.return_to_location) {
      const ledgerRows = (cn.credit_note_lines ?? []).map((l) => ({
        tenant_id:            ctx.tenantId,
        movement_type:        "SALES_RETURN",
        movement_date:        new Date().toISOString().split("T")[0],
        product_id:           l.product_id,
        batch_id:             l.batch_id ?? null,
        to_location_id:       cn.return_to_location,
        qty:                  l.return_qty,   // positive = stock in (returned)
        unit_of_measure:      l.unit_of_measure,
        rate_per_unit:        l.unit_price,
        gst_rate:             l.gst_rate,
        gst_amount:           (l.cgst_amount ?? 0) + (l.sgst_amount ?? 0) + (l.igst_amount ?? 0),
        source_document_type: "CREDIT_NOTE",
        source_document_id:   cnId,
        source_document_no:   cn.credit_note_number,
        narration:            `Sales Return — ${cn.credit_note_number}`,
        created_by:           ctx.userId,
      }));
      const { error: ledgerErr } = await supabase.from("stock_ledger").insert(ledgerRows);
      if (ledgerErr) throw new Error("Stock reversal failed: " + ledgerErr.message);
    }

    await supabase.from("credit_notes").update({
      status: "POSTED", posted_at: new Date().toISOString(), posted_by: ctx.userId,
    }).eq("id", cnId).eq("tenant_id", ctx.tenantId);

    revalidatePath("/sales/credit-notes");
    revalidatePath("/inventory/ledger");
    return { success: true, cnId };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : "Failed to post credit note." };
  }
}

// ─── Get Credit Notes ─────────────────────────────────────────
export async function getCreditNotes() {
  try {
    const supabase = createClient();
    const ctx = await getUserContext();
    const { data, error } = await supabase.from("credit_notes")
      .select(`id, credit_note_number, credit_note_date, reason, status,
               customer_id, customer_name, customer_gstin, parties(name),
               original_invoice_id, sales_invoices(invoice_number),
               goods_returned, taxable_amount, cgst_amount, sgst_amount, igst_amount, total_amount,
               created_at, posted_at`)
      .eq("tenant_id", ctx.tenantId).eq("organisation_id", ctx.organisationId)
      .eq("is_active", true).order("credit_note_date", { ascending: false }).limit(200);
    if (error) throw new Error(error.message);
    return data ?? [];
  } catch (err) { console.error("[credit-notes]", err); return []; }
}
