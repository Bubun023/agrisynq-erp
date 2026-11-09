"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getUserContext, writeAuditLog } from "./context";

// ─── Zod Schema ───────────────────────────────────────────────
const AdjustmentSchema = z.object({
  product_id:    z.string().uuid("Select a product"),
  batch_id:      z.string().uuid("Select a batch"),
  location_id:   z.string().uuid("Select a location"),
  adjustment_qty: z.number().min(0.001, "Quantity must be greater than 0"),
  movement_type: z.enum(["ADJ_INCREASE", "ADJ_DECREASE", "EXPIRY_WRITE_OFF", "DAMAGE_WRITE_OFF"]),
  unit_of_measure: z.string().min(1),
  rate_per_unit:  z.number().min(0).default(0),
  narration:     z.string().min(1, "Narration is required for adjustments"),
  movement_date:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date"),
});

const TransferSchema = z.object({
  product_id:      z.string().uuid("Select a product"),
  batch_id:        z.string().uuid("Select a batch"),
  from_location_id: z.string().uuid("Select source location"),
  to_location_id:   z.string().uuid("Select destination location"),
  transfer_qty:    z.number().min(0.001, "Quantity must be greater than 0"),
  unit_of_measure: z.string().min(1),
  rate_per_unit:   z.number().min(0).default(0),
  narration:       z.string().max(500).optional().or(z.literal("")),
  movement_date:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date"),
}).refine(
  (d) => d.from_location_id !== d.to_location_id,
  { message: "Source and destination locations must be different", path: ["to_location_id"] }
);

export type StockFormState = {
  success?: boolean;
  error?: string;
  fieldErrors?: Record<string, string[]>;
};

// ─── Get Stock Ledger Entries ─────────────────────────────────
export async function getStockLedger(filters?: {
  productId?:  string;
  locationId?: string;
  batchId?:    string;
  fromDate?:   string;
  toDate?:     string;
  movementType?: string;
  limit?:      number;
}) {
  try {
    const supabase = createClient();
    const ctx = await getUserContext();

    let query = supabase
      .from("stock_ledger")
      .select(`
        id, movement_type, movement_date, movement_ts,
        product_id, products(name, product_code),
        batch_id, batch_register(batch_number),
        from_location_id, from_location:locations!stock_ledger_from_location_id_fkey(name, code),
        to_location_id,   to_location:locations!stock_ledger_to_location_id_fkey(name, code),
        party_id, parties(name),
        qty, unit_of_measure, rate_per_unit, taxable_amount, gst_rate, gst_amount,
        source_document_type, source_document_no,
        narration, is_reversal,
        subsidy_amount, fms_transaction_id,
        created_at, created_by
      `)
      .eq("tenant_id", ctx.tenantId)
      .eq("organisation_id", ctx.organisationId)
      .order("movement_date", { ascending: false })
      .order("movement_ts",   { ascending: false })
      .limit(filters?.limit ?? 200);

    if (filters?.productId)    query = query.eq("product_id",    filters.productId);
    if (filters?.locationId)   query = query.or(`to_location_id.eq.${filters.locationId},from_location_id.eq.${filters.locationId}`);
    if (filters?.batchId)      query = query.eq("batch_id",      filters.batchId);
    if (filters?.movementType) query = query.eq("movement_type", filters.movementType);
    if (filters?.fromDate)     query = query.gte("movement_date", filters.fromDate);
    if (filters?.toDate)       query = query.lte("movement_date", filters.toDate);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return data ?? [];
  } catch (err) {
    console.error("[stock-ledger] getStockLedger error:", err);
    return [];
  }
}

// ─── Get Stock Balance ────────────────────────────────────────
// Summary: current balance per product × location (aggregated across batches)
export async function getStockBalance(productId?: string, locationId?: string) {
  try {
    const supabase = createClient();
    const ctx = await getUserContext();

    // stock_balance is a VIEW, so related names cannot be embedded: read the balances, then look names up.
    let q = supabase
      .from("stock_balance")
      .select("product_id, location_id, batch_id, balance_qty, last_movement_date")
      .eq("tenant_id", ctx.tenantId)
      .eq("organisation_id", ctx.organisationId)
      .gt("balance_qty", 0)
      .order("last_movement_date", { ascending: false });
    if (productId)  q = q.eq("product_id", productId);
    if (locationId) q = q.eq("location_id", locationId);

    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    if (rows.length === 0) return [];

    const uniq = (xs: (string | null)[]) => Array.from(new Set(xs.filter((x): x is string => !!x)));
    const [prods, locs, batches] = await Promise.all([
      supabase.from("products").select("id, name, product_code, unit_of_measure").in("id", uniq(rows.map((r) => r.product_id))),
      supabase.from("locations").select("id, name, code").in("id", uniq(rows.map((r) => r.location_id))),
      supabase.from("batch_register").select("id, batch_number, expiry_date").in("id", uniq(rows.map((r) => r.batch_id))),
    ]);
    for (const r of [prods, locs, batches]) if (r.error) throw new Error(r.error.message);
    const byId = <T extends { id: string }>(xs: T[] | null) => new Map((xs ?? []).map((x) => [x.id, x]));
    const P = byId(prods.data), L = byId(locs.data), B = byId(batches.data);

    return rows.map((r) => ({
      ...r,
      products: P.get(r.product_id) ?? null,
      locations: r.location_id ? L.get(r.location_id) ?? null : null,
      batch_register: r.batch_id ? B.get(r.batch_id) ?? null : null,
    }));
  } catch (err) {
    console.error("[stock-ledger] getStockBalance error:", err);
    return [];
  }
}

// ─── Stock Transfer ───────────────────────────────────────────
export async function createStockTransfer(
  _prev: StockFormState,
  formData: FormData
): Promise<StockFormState> {
  try {
    const supabase = createClient();
    const ctx = await getUserContext();

    const raw = {
      product_id:       formData.get("product_id") as string,
      batch_id:         formData.get("batch_id") as string,
      from_location_id: formData.get("from_location_id") as string,
      to_location_id:   formData.get("to_location_id") as string,
      transfer_qty:     Number(formData.get("transfer_qty") || 0),
      unit_of_measure:  formData.get("unit_of_measure") as string,
      rate_per_unit:    Number(formData.get("rate_per_unit") || 0),
      narration:        (formData.get("narration") as string) || "",
      movement_date:    formData.get("movement_date") as string,
    };

    const parsed = TransferSchema.safeParse(raw);
    if (!parsed.success) {
      return { fieldErrors: parsed.error.flatten().fieldErrors };
    }

    const d = parsed.data;

    // Check available stock
    const { data: balanceData } = await supabase.rpc("get_stock_balance", {
      p_tenant_id:   ctx.tenantId,
      p_product_id:  d.product_id,
      p_location_id: d.from_location_id,
      p_batch_id:    d.batch_id,
    });

    const available = Number(balanceData ?? 0);
    if (available < d.transfer_qty) {
      return { error: `Insufficient stock. Available: ${available} ${d.unit_of_measure}, Requested: ${d.transfer_qty}` };
    }

    // Create two ledger entries: TRANSFER_OUT then TRANSFER_IN
    const baseEntry = {
      tenant_id:            ctx.tenantId,
      organisation_id:      ctx.organisationId,
      branch_id:            ctx.branchId,
      movement_date:        d.movement_date,
      product_id:           d.product_id,
      batch_id:             d.batch_id,
      qty:                  d.transfer_qty,
      unit_of_measure:      d.unit_of_measure,
      rate_per_unit:        d.rate_per_unit,
      gst_amount:           0,
      gst_rate:             0,
      source_document_type: "TRANSFER",
      narration:            d.narration || `Stock transfer`,
      created_by:           ctx.userId,
    };

    const { error } = await supabase.from("stock_ledger").insert([
      { ...baseEntry, movement_type: "TRANSFER_OUT", from_location_id: d.from_location_id, to_location_id: d.to_location_id },
      { ...baseEntry, movement_type: "TRANSFER_IN",  from_location_id: d.from_location_id, to_location_id: d.to_location_id },
    ]);

    if (error) throw new Error(error.message);

    await writeAuditLog({
      ctx, action: "INSERT", tableName: "stock_ledger",
      newValues: { movement_type: "TRANSFER", ...d },
    });

    revalidatePath("/inventory/transfers");
    revalidatePath("/inventory/ledger");
    return { success: true };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : "Failed to create transfer." };
  }
}

// ─── Stock Adjustment ─────────────────────────────────────────
export async function createStockAdjustment(
  _prev: StockFormState,
  formData: FormData
): Promise<StockFormState> {
  try {
    const supabase = createClient();
    const ctx = await getUserContext();

    const raw = {
      product_id:     formData.get("product_id") as string,
      batch_id:       formData.get("batch_id") as string,
      location_id:    formData.get("location_id") as string,
      adjustment_qty: Number(formData.get("adjustment_qty") || 0),
      movement_type:  formData.get("movement_type") as string,
      unit_of_measure: formData.get("unit_of_measure") as string,
      rate_per_unit:   Number(formData.get("rate_per_unit") || 0),
      narration:      formData.get("narration") as string,
      movement_date:  formData.get("movement_date") as string,
    };

    const parsed = AdjustmentSchema.safeParse(raw);
    if (!parsed.success) {
      return { fieldErrors: parsed.error.flatten().fieldErrors };
    }

    const d = parsed.data;

    // For decreases: check stock available
    if (["ADJ_DECREASE", "EXPIRY_WRITE_OFF", "DAMAGE_WRITE_OFF"].includes(d.movement_type)) {
      const { data: balanceData } = await supabase.rpc("get_stock_balance", {
        p_tenant_id:   ctx.tenantId,
        p_product_id:  d.product_id,
        p_location_id: d.location_id,
        p_batch_id:    d.batch_id,
      });
      const available = Number(balanceData ?? 0);
      if (available < d.adjustment_qty) {
        return { error: `Insufficient stock. Available: ${available} ${d.unit_of_measure}` };
      }
    }

    const isOutbound = ["ADJ_DECREASE", "EXPIRY_WRITE_OFF", "DAMAGE_WRITE_OFF"].includes(d.movement_type);

    const { error } = await supabase.from("stock_ledger").insert([{
      tenant_id:            ctx.tenantId,
      organisation_id:      ctx.organisationId,
      branch_id:            ctx.branchId,
      movement_type:        d.movement_type,
      movement_date:        d.movement_date,
      product_id:           d.product_id,
      batch_id:             d.batch_id,
      from_location_id:     isOutbound ? d.location_id : null,
      to_location_id:       isOutbound ? null : d.location_id,
      qty:                  d.adjustment_qty,
      unit_of_measure:      d.unit_of_measure,
      rate_per_unit:        d.rate_per_unit,
      gst_amount:           0,
      gst_rate:             0,
      source_document_type: "ADJUSTMENT",
      narration:            d.narration,
      created_by:           ctx.userId,
    }]);

    if (error) throw new Error(error.message);

    await writeAuditLog({
      ctx, action: "INSERT", tableName: "stock_ledger",
      newValues: { ...d },
    });

    revalidatePath("/inventory/adjustments");
    revalidatePath("/inventory/ledger");
    return { success: true };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : "Failed to create adjustment." };
  }
}

// ─── Get Stock Summary (dashboard card data) ─────────────────
export async function getStockSummary() {
  try {
    const supabase = createClient();
    const ctx = await getUserContext();

    // Total products with stock, total batches, low stock count
    const { data, error } = await supabase
      .from("stock_balance")
      .select("product_id, balance_qty")
      .eq("tenant_id", ctx.tenantId)
      .eq("organisation_id", ctx.organisationId)
      .gt("balance_qty", 0);

    if (error) throw new Error(error.message);

    const uniqueProducts = new Set((data ?? []).map((r: { product_id: string }) => r.product_id)).size;
    const totalBatches   = (data ?? []).length;

    return { uniqueProducts, totalBatches };
  } catch {
    return { uniqueProducts: 0, totalBatches: 0 };
  }
}
