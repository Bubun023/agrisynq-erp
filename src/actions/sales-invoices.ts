"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getUserContext, writeAuditLog } from "./context";
import { computeLine, sumLines, resolveInvoiceType, round2 } from "@/lib/gst";

// ─── Schemas ──────────────────────────────────────────────────
const InvLineSchema = z.object({
  product_id:      z.string().uuid("Select a product"),
  so_line_id:      z.string().uuid().optional().or(z.literal("")),
  description:     z.string().max(500).optional().or(z.literal("")),
  hsn_code:        z.string().min(1, "HSN required"),
  batch_id:        z.string().uuid().optional().or(z.literal("")),
  batch_number:    z.string().max(100).optional().or(z.literal("")),
  expiry_date:     z.string().optional().or(z.literal("")),
  qty:             z.number().min(0.001),
  unit_of_measure: z.string().min(1),
  unit_price:      z.number().min(0),
  mrp:             z.number().min(0).optional(),
  discount_percent:z.number().min(0).max(100).default(0),
  gst_rate:        z.number().min(0).max(28).default(0),
});

const InvHeaderSchema = z.object({
  invoice_date:           z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sale_type:              z.enum(["CASH","CREDIT","ADVANCE","SUBSIDY","EXCHANGE"]).default("CASH"),
  so_id:                  z.string().uuid().optional().or(z.literal("")),
  customer_id:            z.string().uuid().optional().or(z.literal("")),
  customer_name:          z.string().max(200).optional().or(z.literal("")),
  customer_gstin:         z.string().max(15).optional().or(z.literal("")),
  customer_phone:         z.string().max(15).optional().or(z.literal("")),
  customer_address:       z.string().max(500).optional().or(z.literal("")),
  customer_state_code:    z.string().length(2).optional().or(z.literal("")),
  from_location:          z.string().uuid("Select dispatch location"),
  place_of_supply:        z.string().length(2).optional().or(z.literal("")),
  is_interstate:          z.boolean().default(false),
  is_reverse_charge:      z.boolean().default(false),
  payment_terms_days:     z.number().int().min(0).max(365).default(0),
  other_charges:          z.number().min(0).default(0),
  round_off:              z.number().default(0),
  narration:              z.string().max(1000).optional().or(z.literal("")),
});

export type SIFormState = {
  success?: boolean; error?: string;
  fieldErrors?: Record<string, string[]>;
  invoiceId?: string; invoiceNumber?: string;
};

// ─── Create Sales Invoice (DRAFT) ────────────────────────────
export async function createSalesInvoice(_prev: SIFormState, formData: FormData): Promise<SIFormState> {
  try {
    const supabase = createClient();
    const ctx = await getUserContext();

    const parsedHeader = InvHeaderSchema.safeParse({
      invoice_date:        formData.get("invoice_date"),
      sale_type:           formData.get("sale_type") || "CASH",
      so_id:               formData.get("so_id") || "",
      customer_id:         formData.get("customer_id") || "",
      customer_name:       formData.get("customer_name") || "",
      customer_gstin:      formData.get("customer_gstin") || "",
      customer_phone:      formData.get("customer_phone") || "",
      customer_address:    formData.get("customer_address") || "",
      customer_state_code: formData.get("customer_state_code") || "",
      from_location:       formData.get("from_location"),
      place_of_supply:     formData.get("place_of_supply") || "",
      is_interstate:       formData.get("is_interstate") === "true",
      is_reverse_charge:   formData.get("is_reverse_charge") === "true",
      payment_terms_days:  Number(formData.get("payment_terms_days") || 0),
      other_charges:       Number(formData.get("other_charges") || 0),
      round_off:           Number(formData.get("round_off") || 0),
      narration:           formData.get("narration") || "",
    });
    if (!parsedHeader.success) return { fieldErrors: parsedHeader.error.flatten().fieldErrors };

    const linesJson = formData.get("lines") as string;
    let rawLines: unknown[];
    try { rawLines = JSON.parse(linesJson); } catch { return { error: "Invalid line items." }; }
    if (!Array.isArray(rawLines) || rawLines.length === 0) return { error: "At least one line required." };
    const parsedLines = z.array(InvLineSchema).safeParse(rawLines);
    if (!parsedLines.success) return { error: parsedLines.error.issues[0]?.message };

    const h = parsedHeader.data;
    const lines = parsedLines.data;

    // Server-side financial calculations (NEVER trusted from browser).
    // Header totals are the sum of the rounded line figures (see lib/gst.ts).
    const calcs = lines.map((line) => computeLine({
      qty: line.qty, unitPrice: line.unit_price, discountPercent: line.discount_percent,
      gstRate: line.gst_rate, isInterstate: h.is_interstate,
    }));
    const tot = sumLines(calcs);
    const grossAmt = tot.gross, totalDiscount = tot.discount, taxableTotal = tot.taxable;
    const cgstTotal = tot.cgst, sgstTotal = tot.sgst, igstTotal = tot.igst;

    const computedLines = lines.map((line, i) => {
      const c = calcs[i];
      return {
        tenant_id: ctx.tenantId, line_no: i + 1,
        so_line_id:      line.so_line_id || null,
        product_id:      line.product_id,
        description:     line.description || null,
        hsn_code:        line.hsn_code,
        batch_id:        line.batch_id || null,
        batch_number:    line.batch_number || null,
        expiry_date:     line.expiry_date || null,
        qty:             line.qty,
        unit_of_measure: line.unit_of_measure,
        unit_price:      line.unit_price,
        mrp:             line.mrp ?? null,
        discount_percent: line.discount_percent,
        discount_amount:  c.discount,
        taxable_amount:   c.taxable,
        gst_rate:        line.gst_rate,
        cgst_rate:       c.cgstRate, cgst_amount: c.cgst,
        sgst_rate:       c.sgstRate, sgst_amount: c.sgst,
        igst_rate:       c.igstRate, igst_amount: c.igst,
        cess_amount:     0,
        line_total:      c.lineTotal,
      };
    });

    const netReceivable = round2(taxableTotal + cgstTotal + sgstTotal + igstTotal + h.other_charges + h.round_off);
    const invoiceType = resolveInvoiceType(h.customer_gstin || null, h.is_interstate, netReceivable);

    const dueDate = h.payment_terms_days > 0
      ? new Date(new Date(h.invoice_date).getTime() + h.payment_terms_days * 86400000).toISOString().split("T")[0]
      : null;

    // Generate invoice number (FY-based: INV-2026-27-NNNNN)
    const { data: invNumData } = await supabase.rpc("generate_invoice_number", {
      p_tenant_id: ctx.tenantId, p_org_id: ctx.organisationId, p_prefix: "INV",
    });
    const invoiceNumber = invNumData as string;

    const { data: si, error: siErr } = await supabase.from("sales_invoices").insert([{
      tenant_id: ctx.tenantId, organisation_id: ctx.organisationId, branch_id: ctx.branchId,
      invoice_number: invoiceNumber, invoice_date: h.invoice_date,
      invoice_type: invoiceType, sale_type: h.sale_type,
      so_id: h.so_id || null,
      customer_id: h.customer_id || null, customer_name: h.customer_name || null,
      customer_gstin: h.customer_gstin || null, customer_phone: h.customer_phone || null,
      customer_address: h.customer_address || null,
      customer_state_code: h.customer_state_code || null,
      from_location: h.from_location,
      place_of_supply: h.place_of_supply || null,
      is_interstate: h.is_interstate, is_reverse_charge: h.is_reverse_charge,
      payment_terms_days: h.payment_terms_days, due_date: dueDate,
      gross_amount:    Math.round(grossAmt * 100) / 100,
      total_discount:  Math.round(totalDiscount * 100) / 100,
      taxable_amount:  Math.round(taxableTotal * 100) / 100,
      cgst_amount:     Math.round(cgstTotal * 100) / 100,
      sgst_amount:     Math.round(sgstTotal * 100) / 100,
      igst_amount:     Math.round(igstTotal * 100) / 100,
      cess_amount:     0,
      other_charges:   h.other_charges,
      round_off:       h.round_off,
      net_receivable:  Math.round(netReceivable * 100) / 100,
      narration: h.narration || null,
      status: "DRAFT", created_by: ctx.userId,
    }]).select("id, invoice_number").single();

    if (siErr || !si) throw new Error(siErr?.message ?? "Failed to create invoice.");

    const lineInserts = computedLines.map((l) => ({ ...l, invoice_id: si.id }));
    const { error: lErr } = await supabase.from("sales_invoice_lines").insert(lineInserts);
    if (lErr) throw new Error("Invoice saved but lines failed: " + lErr.message);

    await writeAuditLog({ ctx, action: "INSERT", tableName: "sales_invoices", recordId: si.id,
      newValues: { invoice_number: si.invoice_number, invoice_type: invoiceType, net_receivable: netReceivable } });
    revalidatePath("/sales/invoices");
    return { success: true, invoiceId: si.id, invoiceNumber: si.invoice_number };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : "Failed to create invoice." };
  }
}

// ─── Post Sales Invoice (DRAFT → POSTED) ─────────────────────
// Posts GST liability and reduces stock from batch_register
export async function postSalesInvoice(invoiceId: string): Promise<SIFormState> {
  try {
    const supabase = createClient();
    const ctx = await getUserContext();

    // One atomic database call: validates stock/batches, writes the stock ledger,
    // the cost-of-goods + sales + GST journal and marks the invoice POSTED (migration 038).
    const { error } = await supabase.rpc("post_sales_invoice", { p_invoice_id: invoiceId });
    if (error) throw new Error(error.message);

    await writeAuditLog({ ctx, action: "POST", tableName: "sales_invoices", recordId: invoiceId,
      newValues: { status: "POSTED" } });
    revalidatePath("/sales/invoices");
    revalidatePath("/inventory/ledger");
    revalidatePath("/accounting/ar");
    return { success: true, invoiceId };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : "Failed to post invoice." };
  }
}

// ─── Get Sales Invoices ───────────────────────────────────────
export async function getSalesInvoices(filters?: {
  status?: string; invoiceType?: string; fromDate?: string; toDate?: string; overdueOnly?: boolean;
}) {
  try {
    const supabase = createClient();
    const ctx = await getUserContext();
    let q = supabase.from("sales_invoices")
      .select(`id, invoice_number, invoice_date, invoice_type, sale_type, status,
               customer_id, customer_name, customer_gstin, customer_phone,
               parties!sales_invoices_customer_id_fkey(name),
               from_location, locations(name, code),
               is_interstate, is_reverse_charge, place_of_supply,
               taxable_amount, cgst_amount, sgst_amount, igst_amount,
               total_gst_amount, other_charges, net_receivable,
               amount_received, outstanding_amount, payment_terms_days, due_date,
               created_at, posted_at`)
      .eq("tenant_id", ctx.tenantId).eq("organisation_id", ctx.organisationId)
      .eq("is_active", true).order("invoice_date", { ascending: false }).limit(300);
    if (filters?.status)      q = q.eq("status", filters.status);
    if (filters?.invoiceType) q = q.eq("invoice_type", filters.invoiceType);
    if (filters?.fromDate)    q = q.gte("invoice_date", filters.fromDate);
    if (filters?.toDate)      q = q.lte("invoice_date", filters.toDate);
    if (filters?.overdueOnly) q = q.gt("outstanding_amount", 0).lt("due_date", new Date().toISOString().split("T")[0]);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data ?? [];
  } catch (err) { console.error("[sales-invoices]", err); return []; }
}

// ─── Get Customer Receivables ────────────────────────────────
export async function getCustomerReceivables() {
  try {
    const supabase = createClient();
    const ctx = await getUserContext();
    const { data, error } = await supabase.from("customer_receivables")
      .select("*").eq("tenant_id", ctx.tenantId).eq("organisation_id", ctx.organisationId)
      .gt("total_outstanding", 0).order("total_outstanding", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  } catch (err) { console.error("[sales-invoices] receivables:", err); return []; }
}

// ─── Get GST Sales Register ───────────────────────────────────
export async function getGSTSalesRegister(fromDate: string, toDate: string) {
  try {
    const supabase = createClient();
    const ctx = await getUserContext();
    const { data, error } = await supabase.from("gst_sales_register")
      .select("*").eq("tenant_id", ctx.tenantId).eq("organisation_id", ctx.organisationId)
      .gte("invoice_date", fromDate).lte("invoice_date", toDate)
      .order("invoice_date", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  } catch (err) { console.error("[sales-invoices] gst-register:", err); return []; }
}
