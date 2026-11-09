"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getUserContext, writeAuditLog } from "./context";

// ─── Schemas ──────────────────────────────────────────────────
const SOLineSchema = z.object({
  product_id:      z.string().uuid("Select a product"),
  description:     z.string().max(500).optional().or(z.literal("")),
  ordered_qty:     z.number().min(0.001, "Quantity > 0"),
  unit_of_measure: z.string().min(1),
  unit_price:      z.number().min(0),
  discount_percent:z.number().min(0).max(100).default(0),
  gst_rate:        z.number().min(0).max(28).default(0),
});

const SOHeaderSchema = z.object({
  customer_id:        z.string().uuid().optional().or(z.literal("")),
  customer_name:      z.string().max(200).optional().or(z.literal("")),
  customer_gstin:     z.string().max(15).optional().or(z.literal("")),
  customer_phone:     z.string().max(15).optional().or(z.literal("")),
  order_date:         z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  delivery_date:      z.string().optional().or(z.literal("")),
  from_location:      z.string().uuid().optional().or(z.literal("")),
  payment_terms_days: z.number().int().min(0).max(365).default(0),
  is_credit_sale:     z.boolean().default(false),
  advance_received:   z.number().min(0).default(0),
  reference_no:       z.string().max(100).optional().or(z.literal("")),
  narration:          z.string().max(1000).optional().or(z.literal("")),
});

export type SOFormState = {
  success?: boolean; error?: string;
  fieldErrors?: Record<string, string[]>;
  soId?: string; soNumber?: string;
};

// ─── Create Sales Order ───────────────────────────────────────
export async function createSalesOrder(_prev: SOFormState, formData: FormData): Promise<SOFormState> {
  try {
    const supabase = createClient();
    const ctx = await getUserContext();

    const parsedHeader = SOHeaderSchema.safeParse({
      customer_id:        formData.get("customer_id") || "",
      customer_name:      formData.get("customer_name") || "",
      customer_gstin:     formData.get("customer_gstin") || "",
      customer_phone:     formData.get("customer_phone") || "",
      order_date:         formData.get("order_date"),
      delivery_date:      formData.get("delivery_date") || "",
      from_location:      formData.get("from_location") || "",
      payment_terms_days: Number(formData.get("payment_terms_days") || 0),
      is_credit_sale:     formData.get("is_credit_sale") === "true",
      advance_received:   Number(formData.get("advance_received") || 0),
      reference_no:       formData.get("reference_no") || "",
      narration:          formData.get("narration") || "",
    });
    if (!parsedHeader.success) return { fieldErrors: parsedHeader.error.flatten().fieldErrors };

    const linesJson = formData.get("lines") as string;
    let rawLines: unknown[];
    try { rawLines = JSON.parse(linesJson); } catch { return { error: "Invalid line items." }; }
    if (!Array.isArray(rawLines) || rawLines.length === 0) return { error: "At least one line is required." };
    const parsedLines = z.array(SOLineSchema).safeParse(rawLines);
    if (!parsedLines.success) return { error: parsedLines.error.issues[0]?.message };

    const h = parsedHeader.data;
    const lines = parsedLines.data;

    // Server-side totals
    let totalTaxable = 0, totalGst = 0;
    for (const l of lines) {
      const taxable = l.ordered_qty * l.unit_price * (1 - l.discount_percent / 100);
      totalTaxable += taxable;
      totalGst += (taxable * l.gst_rate) / 100;
    }

    const { data: numData } = await supabase.rpc("generate_so_number", {
      p_tenant_id: ctx.tenantId, p_org_id: ctx.organisationId,
    });
    const soNumber = numData as string;

    const { data: so, error: soErr } = await supabase
      .from("sales_orders")
      .insert([{
        tenant_id: ctx.tenantId, organisation_id: ctx.organisationId, branch_id: ctx.branchId,
        order_number: soNumber, order_date: h.order_date,
        delivery_date: h.delivery_date || null,
        customer_id: h.customer_id || null, customer_name: h.customer_name || null,
        customer_gstin: h.customer_gstin || null, customer_phone: h.customer_phone || null,
        from_location: h.from_location || null,
        payment_terms_days: h.payment_terms_days, is_credit_sale: h.is_credit_sale,
        advance_received: h.advance_received, reference_no: h.reference_no || null,
        narration: h.narration || null,
        total_taxable_amount: Math.round(totalTaxable * 100) / 100,
        total_gst_amount: Math.round(totalGst * 100) / 100,
        total_amount: Math.round((totalTaxable + totalGst) * 100) / 100,
        status: "DRAFT", created_by: ctx.userId,
      }])
      .select("id, order_number").single();

    if (soErr || !so) throw new Error(soErr?.message ?? "Failed to create order.");

    const lineRows = lines.map((l, i) => {
      const taxable = l.ordered_qty * l.unit_price * (1 - l.discount_percent / 100);
      const gst = (taxable * l.gst_rate) / 100;
      return {
        so_id: so.id, tenant_id: ctx.tenantId, line_no: i + 1,
        product_id: l.product_id, description: l.description || null,
        ordered_qty: l.ordered_qty, unit_of_measure: l.unit_of_measure,
        unit_price: l.unit_price, discount_percent: l.discount_percent,
        taxable_amount: Math.round(taxable * 100) / 100,
        gst_rate: l.gst_rate, gst_amount: Math.round(gst * 100) / 100,
        line_total: Math.round((taxable + gst) * 100) / 100,
      };
    });

    const { error: lErr } = await supabase.from("sales_order_lines").insert(lineRows);
    if (lErr) throw new Error("Order saved but lines failed: " + lErr.message);

    await writeAuditLog({ ctx, action: "INSERT", tableName: "sales_orders", recordId: so.id,
      newValues: { order_number: so.order_number, total_amount: totalTaxable + totalGst } });
    revalidatePath("/sales/orders");
    return { success: true, soId: so.id, soNumber: so.order_number };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : "Failed to create sales order." };
  }
}

// ─── Confirm Order ────────────────────────────────────────────
export async function confirmSalesOrder(soId: string): Promise<SOFormState> {
  try {
    const supabase = createClient();
    const ctx = await getUserContext();
    const { error } = await supabase.from("sales_orders")
      .update({ status: "CONFIRMED", updated_by: ctx.userId })
      .eq("id", soId).eq("tenant_id", ctx.tenantId).eq("status", "DRAFT");
    if (error) throw new Error(error.message);
    revalidatePath("/sales/orders");
    return { success: true };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : "Failed." };
  }
}

// ─── Cancel Order ─────────────────────────────────────────────
export async function cancelSalesOrder(soId: string): Promise<SOFormState> {
  try {
    const supabase = createClient();
    const ctx = await getUserContext();
    const { error } = await supabase.from("sales_orders")
      .update({ status: "CANCELLED", updated_by: ctx.userId })
      .eq("id", soId).eq("tenant_id", ctx.tenantId)
      .in("status", ["DRAFT", "CONFIRMED"]);
    if (error) throw new Error(error.message);
    revalidatePath("/sales/orders");
    return { success: true };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : "Failed." };
  }
}

// ─── Get Sales Orders ─────────────────────────────────────────
export async function getSalesOrders(filters?: { status?: string; fromDate?: string; toDate?: string }) {
  try {
    const supabase = createClient();
    const ctx = await getUserContext();
    let q = supabase.from("sales_orders")
      .select(`id, order_number, order_date, delivery_date, status, reference_no,
               customer_id, customer_name, customer_gstin, customer_phone,
               parties!sales_orders_customer_id_fkey(name),
               is_credit_sale, advance_received, payment_terms_days,
               total_taxable_amount, total_gst_amount, total_amount, created_at`)
      .eq("tenant_id", ctx.tenantId).eq("organisation_id", ctx.organisationId)
      .eq("is_active", true).order("order_date", { ascending: false }).limit(300);
    if (filters?.status) q = q.eq("status", filters.status);
    if (filters?.fromDate) q = q.gte("order_date", filters.fromDate);
    if (filters?.toDate)   q = q.lte("order_date", filters.toDate);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data ?? [];
  } catch (err) { console.error("[sales-orders]", err); return []; }
}

// ─── Create Quotation ─────────────────────────────────────────
export async function createQuotation(_prev: SOFormState, formData: FormData): Promise<SOFormState> {
  try {
    const supabase = createClient();
    const ctx = await getUserContext();

    const linesJson = formData.get("lines") as string;
    let rawLines: unknown[];
    try { rawLines = JSON.parse(linesJson); } catch { return { error: "Invalid lines." }; }
    if (!Array.isArray(rawLines) || rawLines.length === 0) return { error: "Add at least one product." };
    const parsedLines = z.array(SOLineSchema).safeParse(rawLines);
    if (!parsedLines.success) return { error: parsedLines.error.issues[0]?.message };
    const lines = parsedLines.data;

    let totalTaxable = 0, totalGst = 0;
    for (const l of lines) {
      const taxable = l.ordered_qty * l.unit_price * (1 - l.discount_percent / 100);
      totalTaxable += taxable; totalGst += (taxable * l.gst_rate) / 100;
    }

    const { data: numData } = await supabase.rpc("generate_sq_number", {
      p_tenant_id: ctx.tenantId, p_org_id: ctx.organisationId,
    });

    const { data: sq, error: sqErr } = await supabase.from("sales_quotations").insert([{
      tenant_id: ctx.tenantId, organisation_id: ctx.organisationId, branch_id: ctx.branchId,
      quotation_number: numData as string,
      quotation_date:   (formData.get("quotation_date") as string) || new Date().toISOString().split("T")[0],
      valid_until:      (formData.get("valid_until") as string) || null,
      customer_id:      (formData.get("customer_id") as string) || null,
      customer_name:    (formData.get("customer_name") as string) || null,
      customer_phone:   (formData.get("customer_phone") as string) || null,
      reference_no:     (formData.get("reference_no") as string) || null,
      narration:        (formData.get("narration") as string) || null,
      total_taxable_amount: Math.round(totalTaxable * 100) / 100,
      total_gst_amount:     Math.round(totalGst * 100) / 100,
      total_amount:         Math.round((totalTaxable + totalGst) * 100) / 100,
      status: "DRAFT", created_by: ctx.userId,
    }]).select("id, quotation_number").single();

    if (sqErr || !sq) throw new Error(sqErr?.message ?? "Failed.");

    const lineRows = lines.map((l, i) => {
      const taxable = l.ordered_qty * l.unit_price * (1 - l.discount_percent / 100);
      const gst = (taxable * l.gst_rate) / 100;
      return {
        quotation_id: sq.id, tenant_id: ctx.tenantId, line_no: i + 1,
        product_id: l.product_id, ordered_qty: l.ordered_qty, unit_of_measure: l.unit_of_measure,
        unit_price: l.unit_price, discount_percent: l.discount_percent, gst_rate: l.gst_rate,
        taxable_amount: Math.round(taxable * 100) / 100,
        gst_amount:     Math.round(gst * 100) / 100,
        line_total:     Math.round((taxable + gst) * 100) / 100,
      };
    });
    await supabase.from("sales_quotation_lines").insert(lineRows);
    revalidatePath("/sales/quotations");
    return { success: true, soId: sq.id, soNumber: sq.quotation_number };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : "Failed to create quotation." };
  }
}

// ─── Get Quotations ───────────────────────────────────────────
export async function getQuotations() {
  try {
    const supabase = createClient();
    const ctx = await getUserContext();
    const { data, error } = await supabase.from("sales_quotations")
      .select(`id, quotation_number, quotation_date, valid_until, status,
               customer_id, customer_name, customer_phone, parties(name),
               total_taxable_amount, total_gst_amount, total_amount, created_at`)
      .eq("tenant_id", ctx.tenantId).eq("organisation_id", ctx.organisationId)
      .eq("is_active", true).order("quotation_date", { ascending: false }).limit(200);
    if (error) throw new Error(error.message);
    return data ?? [];
  } catch (err) { console.error("[sales-orders] getQuotations:", err); return []; }
}
