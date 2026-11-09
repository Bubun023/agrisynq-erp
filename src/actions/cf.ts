"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getUserContext, writeAuditLog } from "./context";

export type CfConfirmationStatus =
  | "NEVER_CONFIRMED" | "CONFIRMATION_OVERDUE" | "CHANGED_SINCE_CONFIRMED" | "DISCREPANCY" | "CONFIRMED";

export interface CfStockRow {
  location_id: string;
  location_name: string;
  location_type: string;
  cf_agent_id: string | null;
  cf_agent_name: string | null;
  product_id: string;
  product_name: string;
  product_code: string | null;
  unit_of_measure: string;
  batch_id: string | null;
  batch_number: string | null;
  expiry_date: string | null;
  system_qty: number;
  last_movement_date: string | null;
  qty_confirmed: number | null;
  last_confirmed_date: string | null;
  next_confirmation_due: string | null;
  confirmation_ref: string | null;
  discrepancy_noted: boolean | null;
  discrepancy_remarks: string | null;
  unconfirmed_difference: number;
  confirmation_status: CfConfirmationStatus;
}

/** Stock held at C&F depots / third-party locations, derived from the stock ledger. */
export async function getCfStock(): Promise<CfStockRow[]> {
  const supabase = createClient();
  const ctx = await getUserContext();
  const { data, error } = await supabase
    .from("vw_cf_stock")
    .select("*")
    .eq("organisation_id", ctx.organisationId)
    .order("location_name")
    .order("product_name")
    .limit(5000);
  if (error) throw new Error(`C&F stock error: ${error.message}`);
  return (data ?? []) as CfStockRow[];
}

const ConfirmSchema = z.object({
  locationId: z.string().uuid(),
  productId: z.string().uuid(),
  batchId: z.string().uuid().nullable(),
  confirmedQty: z.number().min(0, "Quantity cannot be negative"),
  reference: z.string().trim().max(100).optional().or(z.literal("")),
  remarks: z.string().trim().max(500).optional().or(z.literal("")),
  confirmedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type CfConfirmInput = z.infer<typeof ConfirmSchema>;

/** Record the quantity the C&F agent reports holding. A difference from the system needs a remark. */
export async function recordCfConfirmation(input: CfConfirmInput) {
  const p = ConfirmSchema.safeParse(input);
  if (!p.success) return { success: false as const, error: p.error.issues[0]?.message ?? "Invalid input" };
  const d = p.data;

  const supabase = createClient();
  const ctx = await getUserContext();
  const { data, error } = await supabase.rpc("record_cf_confirmation", {
    p_location_id:      d.locationId,
    p_product_id:       d.productId,
    p_batch_id:         d.batchId,
    p_confirmed_qty:    d.confirmedQty,
    p_confirmation_ref: d.reference || null,
    p_remarks:          d.remarks || null,
    p_confirmed_on:     d.confirmedOn ?? new Date().toISOString().slice(0, 10),
  });
  if (error) return { success: false as const, error: error.message };

  const row = data as { id: string; system_qty: number; confirmed_qty: number; variance_qty: number };
  await writeAuditLog({ ctx, action: "CF_CONFIRM", tableName: "cf_stock_confirmations", recordId: row.id,
    newValues: { system_qty: row.system_qty, confirmed_qty: row.confirmed_qty, variance: row.variance_qty } });
  revalidatePath("/cf-management/stock");
  return { success: true as const, variance: Number(row.variance_qty) };
}

/** C&F withdrawals = transfers out of a C&F agent (to our warehouse or direct to a customer). */
export async function getCfWithdrawals() {
  const supabase = createClient();
  const ctx = await getUserContext();
  const { data, error } = await supabase
    .from("stock_transfers")
    .select(`
      *,
      source_location:locations!stock_transfers_source_location_id_fkey(id, name, location_type),
      destination_location:locations!stock_transfers_destination_location_id_fkey(id, name, location_type),
      cf_agent:parties!stock_transfers_cf_agent_id_fkey(id, name),
      items:stock_transfer_items(
        id, product_id, source_batch_id, unit_of_measure,
        requested_qty, dispatched_qty, received_qty, shortage_qty, damaged_qty, unit_cost,
        product:products(id, name, product_code),
        batch:batch_register!stock_transfer_items_source_batch_id_fkey(id, batch_number, expiry_date)
      )
    `)
    .eq("tenant_id", ctx.tenantId)
    .eq("organisation_id", ctx.organisationId)
    .in("transfer_type", ["CNF_TO_OWN_WAREHOUSE", "CNF_DIRECT_TO_CUSTOMER"])
    .order("created_at", { ascending: false })
    .limit(300);
  if (error) throw new Error(`C&F withdrawals error: ${error.message}`);
  return data ?? [];
}

export async function getOwnLocationOptions() {
  const supabase = createClient();
  const ctx = await getUserContext();
  const { data, error } = await supabase.from("locations")
    .select("id, name, location_type")
    .eq("tenant_id", ctx.tenantId).eq("organisation_id", ctx.organisationId).eq("is_active", true)
    .not("location_type", "in", "(CF_DEPOT,THIRD_PARTY)")
    .order("name");
  if (error) throw new Error(error.message);
  return (data ?? []) as { id: string; name: string; location_type: string }[];
}
