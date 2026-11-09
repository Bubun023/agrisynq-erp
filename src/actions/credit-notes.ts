"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getUserContext, writeAuditLog } from "./context";
import { computeLine, sumLines, round2 } from "@/lib/gst";

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
        tenant_id: ctx.tenantId,
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
    if (clErr) {
      // do not leave an empty draft behind: drafts can be cancelled by their creator
      await supabase.from("credit_notes").update({ status: "CANCELLED" }).eq("id", cn.id).eq("tenant_id", ctx.tenantId);
      throw new Error("Could not save the credit note lines: " + clErr.message);
    }

    await writeAuditLog({ ctx, action: "INSERT", tableName: "credit_notes", recordId: cn.id,
      newValues: { cn_number: cn.credit_note_number, original_invoice_id: originalInvoiceId, total_amount: totalAmount } });
    revalidatePath("/sales/credit-notes");
    return { success: true, cnId: cn.id, cnNumber: cn.credit_note_number };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : "Failed to create credit note." };
  }
}

// ─── Post Credit Note ─────────────────────────────────────────
export async function postCreditNote(cnId: string) {
  try {
    const supabase = createClient();
    const ctx = await getUserContext();

    // Atomic: caps against the original invoice, returns stock + reverses COGS when goods
    // came back, posts the reversal journal and settles the receivable (migration 038).
    const { error } = await supabase.rpc("post_credit_note", { p_cn_id: cnId });
    if (error) throw new Error(error.message);

    await writeAuditLog({ ctx, action: "POST", tableName: "credit_notes", recordId: cnId,
      newValues: { status: "POSTED" } });
    revalidatePath("/sales/credit-notes");
    revalidatePath("/inventory/ledger");
    revalidatePath("/accounting/ar");
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
