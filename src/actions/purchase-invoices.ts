"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getUserContext, writeAuditLog } from "./context";
import { computeLine, sumLines, resolveInvoiceType, round2 } from "@/lib/gst";

// ─── Zod Schemas ──────────────────────────────────────────────
const InvoiceLineSchema = z.object({
  product_id:       z.string().uuid("Select a product"),
  po_line_id:       z.string().uuid().optional().or(z.literal("")),
  description:      z.string().max(500).optional().or(z.literal("")),
  hsn_code:         z.string().min(1, "HSN code is required"),
  batch_number:     z.string().max(100).optional().or(z.literal("")),
  manufacture_date: z.string().optional().or(z.literal("")),
  expiry_date:      z.string().optional().or(z.literal("")),
  received_qty:     z.number().min(0.001, "Quantity must be > 0"),
  free_qty:         z.number().min(0).default(0),
  unit_of_measure:  z.string().min(1, "UoM is required"),
  unit_price:       z.number().min(0),
  discount_percent: z.number().min(0).max(100).default(0),
  gst_rate:         z.number().min(0).max(28).default(0),
});

const InvoiceHeaderSchema = z.object({
  supplier_id:          z.string().uuid("Select a supplier"),
  supplier_type:        z.enum(["REGISTERED","COMPOSITION","UNREGISTERED","IMPORT","SEZ"]).default("REGISTERED"),
  invoice_date:         z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date"),
  supplier_invoice_no:  z.string().max(50).optional().or(z.literal("")),
  supplier_invoice_date:z.string().optional().or(z.literal("")),
  po_id:                z.string().uuid().optional().or(z.literal("")),
  received_at_location: z.string().uuid("Select a receive location"),
  place_of_supply:      z.string().length(2).optional().or(z.literal("")),
  is_interstate:        z.boolean().default(false),
  is_reverse_charge:    z.boolean().default(false),
  payment_terms_days:   z.number().int().min(0).max(365).default(0),
  other_charges:        z.number().min(0).default(0),
  round_off:            z.number().default(0),
  narration:            z.string().max(1000).optional().or(z.literal("")),
});

export type PIFormState = {
  success?: boolean;
  error?: string;
  fieldErrors?: Record<string, string[]>;
  invoiceId?: string;
  invoiceNumber?: string;
};

// ─── Create Purchase Invoice (DRAFT) ─────────────────────────
export async function createPurchaseInvoice(
  _prev: PIFormState,
  formData: FormData
): Promise<PIFormState> {
  try {
    const supabase = createClient();
    const ctx = await getUserContext();

    const rawHeader = {
      supplier_id:           formData.get("supplier_id") as string,
      supplier_type:         (formData.get("supplier_type") as string) || "REGISTERED",
      invoice_date:          formData.get("invoice_date") as string,
      supplier_invoice_no:   (formData.get("supplier_invoice_no") as string) || "",
      supplier_invoice_date: (formData.get("supplier_invoice_date") as string) || "",
      po_id:                 (formData.get("po_id") as string) || "",
      received_at_location:  formData.get("received_at_location") as string,
      place_of_supply:       (formData.get("place_of_supply") as string) || "",
      is_interstate:         formData.get("is_interstate") === "true",
      is_reverse_charge:     formData.get("is_reverse_charge") === "true",
      payment_terms_days:    Number(formData.get("payment_terms_days") || 0),
      other_charges:         Number(formData.get("other_charges") || 0),
      round_off:             Number(formData.get("round_off") || 0),
      narration:             (formData.get("narration") as string) || "",
    };

    const parsedHeader = InvoiceHeaderSchema.safeParse(rawHeader);
    if (!parsedHeader.success) {
      return { fieldErrors: parsedHeader.error.flatten().fieldErrors };
    }

    const linesJson = formData.get("lines") as string;
    let rawLines: unknown[];
    try { rawLines = JSON.parse(linesJson); }
    catch { return { error: "Invalid line items." }; }

    if (!Array.isArray(rawLines) || rawLines.length === 0) {
      return { error: "At least one line item is required." };
    }

    const parsedLines = z.array(InvoiceLineSchema).safeParse(rawLines);
    if (!parsedLines.success) {
      return { error: "Line validation: " + parsedLines.error.issues[0]?.message };
    }

    const lines = parsedLines.data;
    const h = parsedHeader.data;
    const isInterstate = h.is_interstate;

    // Server-side financial calculations (see lib/gst.ts for rounding rules)
    const calcs = lines.map((line) => computeLine({
      qty: line.received_qty, unitPrice: line.unit_price, discountPercent: line.discount_percent,
      gstRate: line.gst_rate, isInterstate,
    }));
    const tot = sumLines(calcs);
    const grossAmount = tot.gross, totalDiscount = tot.discount, taxableTotal = tot.taxable;
    const cgstTotal = tot.cgst, sgstTotal = tot.sgst, igstTotal = tot.igst;

    const computedLines = lines.map((line, i) => {
      const c = calcs[i];
      // Landing cost = taxable / qty
      const landingCost = c.taxable / line.received_qty;

      return {
        tenant_id:            ctx.tenantId,
        line_no:              i + 1,
        po_line_id:           line.po_line_id || null,
        product_id:           line.product_id,
        description:          line.description || null,
        hsn_code:             line.hsn_code,
        batch_number:         line.batch_number || null,
        manufacture_date:     line.manufacture_date || null,
        expiry_date:          line.expiry_date || null,
        received_qty:         line.received_qty,
        free_qty:             line.free_qty,
        unit_of_measure:      line.unit_of_measure,
        unit_price:           line.unit_price,
        discount_percent:     line.discount_percent,
        discount_amount:      c.discount,
        taxable_amount:       c.taxable,
        gst_rate:             line.gst_rate,
        cgst_rate:            c.cgstRate,
        sgst_rate:            c.sgstRate,
        igst_rate:            c.igstRate,
        cgst_amount:          c.cgst,
        sgst_amount:          c.sgst,
        igst_amount:          c.igst,
        cess_amount:          0,
        line_total:           c.lineTotal,
        landing_cost_per_unit: Math.round(landingCost * 10000) / 10000,
      };
    });

    const netPayable = round2(taxableTotal + cgstTotal + sgstTotal + igstTotal + h.other_charges + h.round_off);

    // Due date
    const invoiceDateObj = new Date(h.invoice_date);
    const dueDate = h.payment_terms_days > 0
      ? new Date(invoiceDateObj.getTime() + h.payment_terms_days * 86400000).toISOString().split("T")[0]
      : null;

    // Generate invoice number
    const { data: piNumData } = await supabase.rpc("generate_pi_number", {
      p_tenant_id:       ctx.tenantId,
      p_organisation_id: ctx.organisationId,
    });
    const invoiceNumber = piNumData as string;

    // Insert header
    const { data: pi, error: piErr } = await supabase
      .from("purchase_invoices")
      .insert([{
        tenant_id:             ctx.tenantId,
        organisation_id:       ctx.organisationId,
        branch_id:             ctx.branchId,
        invoice_number:        invoiceNumber,
        invoice_date:          h.invoice_date,
        supplier_invoice_no:   h.supplier_invoice_no || null,
        supplier_invoice_date: h.supplier_invoice_date || null,
        po_id:                 h.po_id || null,
        supplier_id:           h.supplier_id,
        supplier_type:         h.supplier_type,
        received_at_location:  h.received_at_location,
        place_of_supply:       h.place_of_supply || null,
        is_interstate:         isInterstate,
        is_reverse_charge:     h.is_reverse_charge,
        payment_terms_days:    h.payment_terms_days,
        due_date:              dueDate,
        gross_amount:          Math.round(grossAmount * 100) / 100,
        total_discount:        Math.round(totalDiscount * 100) / 100,
        taxable_amount:        Math.round(taxableTotal * 100) / 100,
        cgst_amount:           Math.round(cgstTotal * 100) / 100,
        sgst_amount:           Math.round(sgstTotal * 100) / 100,
        igst_amount:           Math.round(igstTotal * 100) / 100,
        cess_amount:           0,
        other_charges:         h.other_charges,
        round_off:             h.round_off,
        net_payable:           Math.round(netPayable * 100) / 100,
        narration:             h.narration || null,
        status:                "DRAFT",
        created_by:            ctx.userId,
      }])
      .select("id, invoice_number")
      .single();

    if (piErr || !pi) throw new Error(piErr?.message ?? "Failed to create invoice.");

    // Insert lines
    const lineInserts = computedLines.map((l) => ({ ...l, invoice_id: pi.id }));
    const { error: lineErr } = await supabase.from("purchase_invoice_lines").insert(lineInserts);
    if (lineErr) throw new Error("Invoice created but lines failed: " + lineErr.message);

    await writeAuditLog({
      ctx, action: "INSERT", tableName: "purchase_invoices",
      recordId: pi.id,
      newValues: { invoice_number: pi.invoice_number, supplier_id: h.supplier_id, net_payable: netPayable },
    });

    revalidatePath("/purchases/invoices");
    return { success: true, invoiceId: pi.id, invoiceNumber: pi.invoice_number };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : "Failed to create purchase invoice." };
  }
}

// ─── Post Purchase Invoice (DRAFT → POSTED) ──────────────────
// This is the critical action: updates stock_ledger + batch_register
export async function postPurchaseInvoice(invoiceId: string): Promise<PIFormState> {
  try {
    const supabase = createClient();
    const ctx = await getUserContext();

    // Fetch invoice with lines
    const { data: invoice, error: fetchErr } = await supabase
      .from("purchase_invoices")
      .select(`
        id, invoice_number, invoice_date, status, received_at_location,
        supplier_id, organisation_id,
        purchase_invoice_lines (
          id, product_id, hsn_code, batch_number, manufacture_date, expiry_date,
          received_qty, free_qty, unit_of_measure,
          unit_price, taxable_amount, gst_rate,
          cgst_amount, sgst_amount, igst_amount,
          landing_cost_per_unit, line_total
        )
      `)
      .eq("id", invoiceId)
      .eq("tenant_id", ctx.tenantId)
      .single();

    if (fetchErr || !invoice) throw new Error("Invoice not found.");
    if (invoice.status !== "DRAFT") throw new Error("Only DRAFT invoices can be posted.");

    const lines = invoice.purchase_invoice_lines ?? [];
    if (lines.length === 0) throw new Error("Invoice has no line items.");

    // For each line: create batch_register entry + GRN ledger entry
    const batchRows = [];
    const ledgerRows = [];
    const lineUpdates = [];

    for (const line of lines) {
      const totalQty = line.received_qty + line.free_qty;

      // Check if batch already exists for this product
      const batchNum = line.batch_number || `${invoice.invoice_number}-L${lines.indexOf(line) + 1}`;

      const { data: existingBatch } = await supabase
        .from("batch_register")
        .select("id")
        .eq("tenant_id", ctx.tenantId)
        .eq("organisation_id", ctx.organisationId ?? invoice.organisation_id)
        .eq("product_id", line.product_id)
        .eq("batch_number", batchNum)
        .maybeSingle();

      let batchId: string;

      if (existingBatch) {
        // Update existing batch qty
        batchId = existingBatch.id;
        await supabase.from("batch_register").update({
          current_qty: supabase.rpc("get_stock_balance", { p_tenant_id: ctx.tenantId, p_product_id: line.product_id }) as unknown as number,
          updated_by: ctx.userId,
        }).eq("id", batchId);
      } else {
        // Create new batch
        const { data: newBatch, error: batchErr } = await supabase
          .from("batch_register")
          .insert([{
            tenant_id:              ctx.tenantId,
            organisation_id:        invoice.organisation_id,
            branch_id:              ctx.branchId,
            batch_number:           batchNum,
            product_id:             line.product_id,
            supplier_id:            invoice.supplier_id,
            purchase_invoice_id:    invoiceId,
            location_id:            invoice.received_at_location,
            opening_qty:            totalQty,
            current_qty:            totalQty,
            unit_of_measure:        line.unit_of_measure,
            purchase_rate:          line.unit_price,
            purchase_rate_with_tax: line.landing_cost_per_unit,
            landing_cost_per_unit:  line.landing_cost_per_unit,
            manufacture_date:       line.manufacture_date || null,
            expiry_date:            line.expiry_date || null,
            status:                 "OPEN",
            created_by:             ctx.userId,
          }])
          .select("id")
          .single();

        if (batchErr || !newBatch) throw new Error("Failed to create batch: " + batchErr?.message);
        batchId = newBatch.id;
      }

      // Stock ledger GRN entry
      ledgerRows.push({
        tenant_id:            ctx.tenantId,
        organisation_id:      invoice.organisation_id,
        branch_id:            ctx.branchId,
        movement_type:        "GRN",
        movement_date:        invoice.invoice_date,
        product_id:           line.product_id,
        batch_id:             batchId,
        to_location_id:       invoice.received_at_location,
        party_id:             invoice.supplier_id,
        qty:                  totalQty,
        unit_of_measure:      line.unit_of_measure,
        rate_per_unit:        line.unit_price,
        gst_rate:             line.gst_rate,
        gst_amount:           (line.cgst_amount + line.sgst_amount + line.igst_amount),
        source_document_type: "PURCHASE_INVOICE",
        source_document_id:   invoiceId,
        source_document_no:   invoice.invoice_number,
        narration:            `GRN — ${invoice.invoice_number}`,
        created_by:           ctx.userId,
      });

      lineUpdates.push({ lineId: line.id, batchId });
    }

    // Insert all ledger entries
    const { error: ledgerErr } = await supabase.from("stock_ledger").insert(ledgerRows);
    if (ledgerErr) throw new Error("GRN stock entries failed: " + ledgerErr.message);

    // Update line batch_id references
    for (const lu of lineUpdates) {
      await supabase.from("purchase_invoice_lines")
        .update({ batch_id: lu.batchId })
        .eq("id", lu.lineId);
    }

    // Mark invoice as POSTED
    const { error: postErr } = await supabase
      .from("purchase_invoices")
      .update({
        status:     "POSTED",
        posted_at:  new Date().toISOString(),
        posted_by:  ctx.userId,
        updated_by: ctx.userId,
      })
      .eq("id", invoiceId)
      .eq("tenant_id", ctx.tenantId);

    if (postErr) throw new Error("Failed to mark invoice as posted: " + postErr.message);

    await writeAuditLog({
      ctx, action: "POST", tableName: "purchase_invoices",
      recordId: invoiceId,
      newValues: { status: "POSTED", posted_at: new Date().toISOString() },
    });

    revalidatePath("/purchases/invoices");
    revalidatePath("/inventory/batches");
    revalidatePath("/inventory/ledger");
    return { success: true, invoiceId };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : "Failed to post invoice." };
  }
}

// ─── Get Purchase Invoices ────────────────────────────────────
export async function getPurchaseInvoices(filters?: {
  supplierId?: string;
  status?: string;
  fromDate?: string;
  toDate?: string;
  overdueOnly?: boolean;
}) {
  try {
    const supabase = createClient();
    const ctx = await getUserContext();

    let query = supabase
      .from("purchase_invoices")
      .select(`
        id, invoice_number, invoice_date, status,
        supplier_invoice_no, supplier_invoice_date,
        supplier_id, parties(name, gstin),
        received_at_location, locations(name, code),
        is_interstate, is_reverse_charge,
        taxable_amount, cgst_amount, sgst_amount, igst_amount,
        other_charges, net_payable, amount_paid, outstanding_amount,
        payment_terms_days, due_date,
        created_at, posted_at
      `)
      .eq("tenant_id", ctx.tenantId)
      .eq("organisation_id", ctx.organisationId)
      .eq("is_active", true)
      .order("invoice_date", { ascending: false })
      .limit(200);

    if (filters?.supplierId)  query = query.eq("supplier_id", filters.supplierId);
    if (filters?.status)      query = query.eq("status", filters.status);
    if (filters?.fromDate)    query = query.gte("invoice_date", filters.fromDate);
    if (filters?.toDate)      query = query.lte("invoice_date", filters.toDate);
    if (filters?.overdueOnly) query = query.gt("outstanding_amount", 0).lt("due_date", new Date().toISOString().split("T")[0]);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return data ?? [];
  } catch (err) {
    console.error("[purchase-invoices] getPurchaseInvoices:", err);
    return [];
  }
}

// ─── Get Supplier Payables Summary ───────────────────────────
export async function getSupplierPayables() {
  try {
    const supabase = createClient();
    const ctx = await getUserContext();

    const { data, error } = await supabase
      .from("supplier_payables")
      .select("*")
      .eq("tenant_id", ctx.tenantId)
      .eq("organisation_id", ctx.organisationId)
      .gt("total_outstanding", 0)
      .order("total_outstanding", { ascending: false });

    if (error) throw new Error(error.message);
    return data ?? [];
  } catch (err) {
    console.error("[purchase-invoices] getSupplierPayables:", err);
    return [];
  }
}
