"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getUserContext, writeAuditLog } from "./context";

const FarmerSaleSchema = z.object({
  farmer_id:             z.string().uuid("Select a farmer"),
  product_id:            z.string().uuid("Select a product"),
  hsn_code:              z.string().min(1, "HSN required"),
  batch_id:              z.string().uuid().optional().or(z.literal("")),
  batch_number:          z.string().max(100).optional().or(z.literal("")),
  sale_at_location:      z.string().uuid("Select sale location"),
  sale_date:             z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  season:                z.string().max(20).optional().or(z.literal("")),
  financial_year:        z.string().max(10).optional().or(z.literal("")),
  qty_sold:              z.number().min(0.001, "Qty > 0"),
  unit_of_measure:       z.string().min(1),
  pack_size:             z.number().min(0).optional(),
  mrp_per_unit:          z.number().min(0).optional(),
  selling_price_per_unit:z.number().min(0, "Enter selling price"),
  subsidy_per_unit:      z.number().min(0).default(0),
  gst_rate:              z.number().min(0).max(28).default(0),
  subsidy_type:          z.enum(["NEEM_COATED_UREA","NBS_FERTILIZER","STATE_SUBSIDY","NONE"]).default("NONE"),
  subsidy_scheme:        z.string().max(200).optional().or(z.literal("")),
  fms_dealer_id:         z.string().max(50).optional().or(z.literal("")),
  fms_product_code:      z.string().max(50).optional().or(z.literal("")),
  pos_transaction_id:    z.string().max(100).optional().or(z.literal("")),
  pos_device_id:         z.string().max(100).optional().or(z.literal("")),
  cash_received:         z.number().min(0).default(0),
  narration:             z.string().max(500).optional().or(z.literal("")),
});

export type FSFormState = {
  success?: boolean; error?: string;
  fieldErrors?: Record<string, string[]>;
  saleId?: string; saleNumber?: string;
};

// ─── Create Farmer Sale ───────────────────────────────────────
export async function createFarmerSale(_prev: FSFormState, formData: FormData): Promise<FSFormState> {
  try {
    const supabase = createClient();
    const ctx = await getUserContext();

    const raw: Record<string, unknown> = {
      farmer_id:             formData.get("farmer_id"),
      product_id:            formData.get("product_id"),
      hsn_code:              formData.get("hsn_code"),
      batch_id:              formData.get("batch_id") || "",
      batch_number:          formData.get("batch_number") || "",
      sale_at_location:      formData.get("sale_at_location"),
      sale_date:             formData.get("sale_date"),
      season:                formData.get("season") || "",
      financial_year:        formData.get("financial_year") || "",
      qty_sold:              Number(formData.get("qty_sold")),
      unit_of_measure:       formData.get("unit_of_measure"),
      pack_size:             formData.get("pack_size") ? Number(formData.get("pack_size")) : undefined,
      mrp_per_unit:          formData.get("mrp_per_unit") ? Number(formData.get("mrp_per_unit")) : undefined,
      selling_price_per_unit:Number(formData.get("selling_price_per_unit")),
      subsidy_per_unit:      Number(formData.get("subsidy_per_unit") || 0),
      gst_rate:              Number(formData.get("gst_rate") || 0),
      subsidy_type:          formData.get("subsidy_type") || "NONE",
      subsidy_scheme:        formData.get("subsidy_scheme") || "",
      fms_dealer_id:         formData.get("fms_dealer_id") || "",
      fms_product_code:      formData.get("fms_product_code") || "",
      pos_transaction_id:    formData.get("pos_transaction_id") || "",
      pos_device_id:         formData.get("pos_device_id") || "",
      cash_received:         Number(formData.get("cash_received") || 0),
      narration:             formData.get("narration") || "",
    };

    const parsed = FarmerSaleSchema.safeParse(raw);
    if (!parsed.success) return { fieldErrors: parsed.error.flatten().fieldErrors };
    const d = parsed.data;

    // Block duplicate PoS transaction IDs
    if (d.pos_transaction_id) {
      const { data: existingPoS } = await supabase.from("farmer_sales")
        .select("id").eq("tenant_id", ctx.tenantId).eq("pos_transaction_id", d.pos_transaction_id)
        .maybeSingle();
      if (existingPoS) return { error: `PoS Transaction ID "${d.pos_transaction_id}" has already been recorded. Duplicate PoS IDs are not permitted.` };
    }

    // Fetch farmer snapshot
    const { data: farmer } = await supabase.from("farmers")
      .select("first_name, last_name, phone, aadhaar_last4, village, district")
      .eq("id", d.farmer_id).eq("tenant_id", ctx.tenantId).single();
    if (!farmer) return { error: "Farmer not found." };

    // Server-side financial calculation
    const grossAmount         = d.qty_sold * d.selling_price_per_unit;
    const totalSubsidy        = d.qty_sold * d.subsidy_per_unit;
    const farmerPayable       = d.qty_sold * (d.selling_price_per_unit - d.subsidy_per_unit);
    const gstAmount           = (farmerPayable * d.gst_rate) / 100;
    const netAmount           = farmerPayable + gstAmount;
    if (d.cash_received > Math.round(netAmount * 100) / 100 + 0.001) {
      return { error: `Cash received (${d.cash_received}) cannot exceed the amount payable (${netAmount.toFixed(2)}).` };
    }
    const creditAmount        = Math.max(0, Math.round((netAmount - d.cash_received) * 100) / 100);

    const { data: numData } = await supabase.rpc("generate_fs_number", {
      p_tenant_id: ctx.tenantId, p_org_id: ctx.organisationId,
    });

    const { data: fs, error: fsErr } = await supabase.from("farmer_sales").insert([{
      tenant_id: ctx.tenantId, organisation_id: ctx.organisationId, branch_id: ctx.branchId,
      sale_number:           numData as string,
      sale_date:             d.sale_date,
      season:                d.season || null,
      financial_year:        d.financial_year || null,
      farmer_id:             d.farmer_id,
      farmer_name:           `${farmer.first_name} ${farmer.last_name}`.trim(),
      farmer_aadhaar_last4:  farmer.aadhaar_last4 ?? null,
      farmer_phone:          farmer.phone ?? null,
      sale_at_location:      d.sale_at_location,
      farmer_village:        farmer.village ?? null,
      farmer_district:       farmer.district ?? null,
      product_id:            d.product_id,
      hsn_code:              d.hsn_code,
      batch_id:              d.batch_id || null,
      batch_number:          d.batch_number || null,
      qty_sold:              d.qty_sold,
      unit_of_measure:       d.unit_of_measure,
      pack_size:             d.pack_size ?? null,
      mrp_per_unit:          d.mrp_per_unit ?? null,
      selling_price_per_unit:d.selling_price_per_unit,
      subsidy_per_unit:      d.subsidy_per_unit,
      subsidy_rate_per_unit: d.subsidy_per_unit,
      gst_rate:              d.gst_rate,
      gst_amount:            Math.round(gstAmount * 100) / 100,
      gross_amount:          Math.round(grossAmount * 100) / 100,
      total_subsidy_amount:  Math.round(totalSubsidy * 100) / 100,
      farmer_payable_amount: Math.round(farmerPayable * 100) / 100,
      net_amount:            Math.round(netAmount * 100) / 100,
      cash_received:         Math.round(d.cash_received * 100) / 100,
      credit_amount:         Math.round(creditAmount * 100) / 100,
      subsidy_type:          d.subsidy_type,
      subsidy_scheme:        d.subsidy_scheme || null,
      fms_dealer_id:         d.fms_dealer_id || null,
      fms_product_code:      d.fms_product_code || null,
      pos_transaction_id:    d.pos_transaction_id || null,
      pos_device_id:         d.pos_device_id || null,
      pos_recorded_at:       d.pos_transaction_id ? new Date().toISOString() : null,
      narration:             d.narration || null,
      status:                d.pos_transaction_id ? "POS_RECORDED" : "POS_PENDING",
      created_by:            ctx.userId,
    }]).select("id, sale_number").single();

    if (fsErr || !fs) throw new Error(fsErr?.message ?? "Failed to create farmer sale.");

    await writeAuditLog({ ctx, action: "INSERT", tableName: "farmer_sales", recordId: fs.id,
      newValues: { sale_number: fs.sale_number, farmer_id: d.farmer_id, qty_sold: d.qty_sold, net_amount: netAmount } });
    revalidatePath("/sales/farmer-sales");
    return { success: true, saleId: fs.id, saleNumber: fs.sale_number };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : "Failed to create farmer sale." };
  }
}

// ─── Post Farmer Sale ─────────────────────────────────────────
// Atomic (migration 040): checks PoS/subsidy rules, stock and batch, writes the stock
// movement, the sales + GST + subsidy-receivable + COGS journal, and marks it POSTED.
export async function postFarmerSale(saleId: string): Promise<FSFormState> {
  try {
    const supabase = createClient();
    const ctx = await getUserContext();

    const { error } = await supabase.rpc("post_farmer_sale", { p_sale_id: saleId });
    if (error) throw new Error(error.message);

    await writeAuditLog({ ctx, action: "POST", tableName: "farmer_sales", recordId: saleId,
      newValues: { status: "POSTED" } });
    revalidatePath("/sales/memo");
    revalidatePath("/fms/ledger");
    revalidatePath("/inventory/ledger");
    return { success: true, saleId };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : "Failed to post farmer sale." };
  }
}

// ─── Get Farmer Sales ─────────────────────────────────────────
export async function getFarmerSales(filters?: {
  farmerId?: string; productId?: string; status?: string;
  season?: string; fromDate?: string; toDate?: string;
}) {
  try {
    const supabase = createClient();
    const ctx = await getUserContext();
    let q = supabase.from("farmer_sales")
      .select(`id, sale_number, sale_date, status, season, financial_year,
               farmer_id, farmer_name, farmer_phone, farmer_aadhaar_last4,
               farmers(first_name, last_name, phone),
               product_id, products(name, product_code),
               qty_sold, unit_of_measure,
               selling_price_per_unit, subsidy_per_unit,
               gross_amount, total_subsidy_amount, farmer_payable_amount, net_amount,
               cash_received, credit_amount, gst_rate, gst_amount,
               subsidy_type, pos_transaction_id, fms_dealer_id,
               created_at, posted_at`)
      .eq("tenant_id", ctx.tenantId).eq("organisation_id", ctx.organisationId)
      .eq("is_active", true).order("sale_date", { ascending: false }).limit(300);
    if (filters?.farmerId)  q = q.eq("farmer_id", filters.farmerId);
    if (filters?.productId) q = q.eq("product_id", filters.productId);
    if (filters?.status)    q = q.eq("status", filters.status);
    if (filters?.season)    q = q.eq("season", filters.season);
    if (filters?.fromDate)  q = q.gte("sale_date", filters.fromDate);
    if (filters?.toDate)    q = q.lte("sale_date", filters.toDate);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data ?? [];
  } catch (err) { console.error("[farmer-sales]", err); return []; }
}

// ─── Get FMS Reconciliation ───────────────────────────────────
export async function getFMSReconciliations() {
  try {
    const supabase = createClient();
    const ctx = await getUserContext();
    const { data, error } = await supabase.from("fms_reconciliation")
      .select("*").eq("tenant_id", ctx.tenantId).eq("organisation_id", ctx.organisationId)
      .order("reconciliation_date", { ascending: false }).limit(100);
    if (error) throw new Error(error.message);
    return data ?? [];
  } catch (err) { console.error("[farmer-sales] fms:", err); return []; }
}
