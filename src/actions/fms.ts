"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getUserContext, writeAuditLog } from "./context";

// ─── Types ────────────────────────────────────────────────────

export type ComplianceFlag = "OK" | "MISSING_POS" | "POS_PENDING" | "NO_DEALER_ID" | "CANCELLED";

export interface FmsLedgerRow {
  id: string;
  sale_number: string;
  sale_date: string;
  season: string | null;
  farmer_name: string;
  farmer_aadhaar_last4: string | null;
  farmer_village: string | null;
  farmer_district: string | null;
  product_name: string;
  product_code: string | null;
  fms_product_code: string | null;
  hsn_code: string;
  batch_number: string | null;
  qty_sold: number;
  unit_of_measure: string;
  selling_price_per_unit: number;
  subsidy_per_unit: number;
  total_subsidy_amount: number;
  farmer_payable_amount: number;
  net_amount: number;
  subsidy_type: string;
  pos_transaction_id: string | null;
  pos_device_id: string | null;
  fms_dealer_id: string | null;
  fms_acknowledgement_no: string | null;
  status: string;
  compliance_flag: ComplianceFlag;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  reissued_from_id: string | null;
  reissued_as_id: string | null;
  reissued_as_number: string | null;
  reissued_from_number: string | null;
}

export interface FmsReconciliationRow {
  id: string;
  reconciliation_date: string;
  period_from: string;
  period_to: string;
  fms_dealer_id: string;
  fms_product_code: string | null;
  fms_total_qty: number;
  fms_total_transactions: number;
  fms_total_subsidy: number;
  system_total_qty: number;
  system_total_transactions: number;
  system_total_subsidy: number;
  qty_variance: number;
  subsidy_variance: number;
  reconciliation_status: "PENDING" | "MATCHED" | "VARIANCE" | "RESOLVED";
  remarks: string | null;
  resolved_at: string | null;
}

// ─── FMS Ledger ───────────────────────────────────────────────

export async function getFmsLedger(filters?: {
  fromDate?: string;
  toDate?: string;
  flag?: string;
  subsidyType?: string;
  search?: string;
}): Promise<FmsLedgerRow[]> {
  const supabase = createClient();
  const ctx = await getUserContext();

  let q = supabase
    .from("vw_fms_ledger")
    .select("*")
    .eq("organisation_id", ctx.organisationId)
    .order("sale_date", { ascending: false })
    .order("sale_number", { ascending: false })
    .limit(2000);

  if (filters?.fromDate)    q = q.gte("sale_date", filters.fromDate);
  if (filters?.toDate)      q = q.lte("sale_date", filters.toDate);
  if (filters?.flag)        q = q.eq("compliance_flag", filters.flag);
  if (filters?.subsidyType) q = q.eq("subsidy_type", filters.subsidyType);
  if (filters?.search) {
    // strip characters that have meaning in PostgREST filter syntax
    const s = filters.search.replace(/[,()%*]/g, " ").trim();
    if (s) q = q.or(`farmer_name.ilike.%${s}%,pos_transaction_id.ilike.%${s}%,sale_number.ilike.%${s}%`);
  }

  const { data, error } = await q;
  if (error) throw new Error(`FMS ledger error: ${error.message}`);
  return (data ?? []) as FmsLedgerRow[];
}

// ─── Reconciliation ───────────────────────────────────────────

export async function getFmsReconciliations(): Promise<FmsReconciliationRow[]> {
  const supabase = createClient();
  const ctx = await getUserContext();
  const { data, error } = await supabase
    .from("fms_reconciliation")
    .select("*")
    .eq("tenant_id", ctx.tenantId)
    .eq("organisation_id", ctx.organisationId)
    .order("reconciliation_date", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`FMS reconciliation error: ${error.message}`);
  return (data ?? []) as FmsReconciliationRow[];
}

const ReconSchema = z.object({
  period_from:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Select the period start"),
  period_to:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Select the period end"),
  dealer_id:     z.string().trim().min(1, "FMS dealer ID is required").max(50),
  product_code:  z.string().trim().max(50).optional().or(z.literal("")),
  fms_qty:       z.number().min(0),
  fms_txns:      z.number().int().min(0),
  fms_subsidy:   z.number().min(0),
  remarks:       z.string().max(500).optional().or(z.literal("")),
});
export type ReconInput = z.infer<typeof ReconSchema>;

export async function runFmsReconciliation(input: ReconInput) {
  const parsed = ReconSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const d = parsed.data;

  const supabase = createClient();
  const ctx = await getUserContext();

  const { data, error } = await supabase.rpc("run_fms_reconciliation", {
    p_organisation_id: ctx.organisationId,
    p_period_from:     d.period_from,
    p_period_to:       d.period_to,
    p_dealer_id:       d.dealer_id,
    p_product_code:    d.product_code || null,
    p_fms_qty:         d.fms_qty,
    p_fms_txns:        d.fms_txns,
    p_fms_subsidy:     d.fms_subsidy,
    p_remarks:         d.remarks || null,
  });
  if (error) return { success: false, error: error.message };

  const row = data as FmsReconciliationRow;
  await writeAuditLog({ ctx, action: "FMS_RECONCILE", tableName: "fms_reconciliation", recordId: row.id,
    newValues: { status: row.reconciliation_status, period_from: d.period_from, period_to: d.period_to } });
  revalidatePath("/fms/reconciliation");
  return { success: true, data: row };
}

export async function resolveFmsReconciliation(id: string, remarks: string) {
  const supabase = createClient();
  const ctx = await getUserContext();

  const { data, error } = await supabase.rpc("resolve_fms_reconciliation", { p_id: id, p_remarks: remarks });
  if (error) return { success: false, error: error.message };

  await writeAuditLog({ ctx, action: "FMS_RESOLVE", tableName: "fms_reconciliation", recordId: id, reason: remarks });
  revalidatePath("/fms/reconciliation");
  return { success: true, data: data as FmsReconciliationRow };
}

// ─── Cancel & Reissue ─────────────────────────────────────────

/** Sales that can still be cancelled (not yet cancelled, subsidy not yet claimed). */
export async function getCancellableFarmerSales(): Promise<FmsLedgerRow[]> {
  const supabase = createClient();
  const ctx = await getUserContext();
  const { data, error } = await supabase
    .from("vw_fms_ledger")
    .select("*")
    .eq("organisation_id", ctx.organisationId)
    .in("status", ["POS_PENDING", "POS_RECORDED", "POSTED"])
    .order("sale_date", { ascending: false })
    .limit(500);
  if (error) throw new Error(`Cancellable sales error: ${error.message}`);
  return (data ?? []) as FmsLedgerRow[];
}

export async function getCancelledFarmerSales(): Promise<FmsLedgerRow[]> {
  const supabase = createClient();
  const ctx = await getUserContext();
  const { data, error } = await supabase
    .from("vw_fms_ledger")
    .select("*")
    .eq("organisation_id", ctx.organisationId)
    .eq("status", "CANCELLED")
    .order("cancelled_at", { ascending: false })
    .limit(200);
  if (error) throw new Error(`Cancelled sales error: ${error.message}`);
  return (data ?? []) as FmsLedgerRow[];
}

export async function cancelFarmerSale(saleId: string, reason: string) {
  const supabase = createClient();
  const ctx = await getUserContext();
  const { error } = await supabase.rpc("cancel_farmer_sale", { p_sale_id: saleId, p_reason: reason });
  if (error) return { success: false, error: error.message };

  await writeAuditLog({ ctx, action: "FMS_CANCEL", tableName: "farmer_sales", recordId: saleId, reason });
  revalidatePath("/fms/reissue");
  revalidatePath("/fms/ledger");
  revalidatePath("/inventory/ledger");
  return { success: true };
}

const ReissueSchema = z.object({
  saleId:        z.string().uuid(),
  reason:        z.string().trim().min(3, "Enter the reason for cancelling").max(500),
  newPosId:      z.string().trim().min(1, "A new PoS transaction ID is required").max(100),
  qty:           z.number().positive("Quantity must be greater than 0").optional(),
  sellingPrice:  z.number().min(0).optional(),
  subsidyPerUnit:z.number().min(0).optional(),
});
export type ReissueInput = z.infer<typeof ReissueSchema>;

export async function reissueFarmerSale(input: ReissueInput) {
  const parsed = ReissueSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const d = parsed.data;

  const supabase = createClient();
  const ctx = await getUserContext();
  const { data, error } = await supabase.rpc("reissue_farmer_sale", {
    p_sale_id:          d.saleId,
    p_reason:           d.reason,
    p_new_pos_id:       d.newPosId,
    p_qty:              d.qty ?? null,
    p_selling_price:    d.sellingPrice ?? null,
    p_subsidy_per_unit: d.subsidyPerUnit ?? null,
  });
  if (error) return { success: false, error: error.message };

  const row = data as { id: string; sale_number: string };
  await writeAuditLog({ ctx, action: "FMS_REISSUE", tableName: "farmer_sales", recordId: d.saleId, reason: d.reason,
    newValues: { reissued_as: row.sale_number, new_pos_id: d.newPosId } });
  revalidatePath("/fms/reissue");
  revalidatePath("/fms/ledger");
  revalidatePath("/inventory/ledger");
  return { success: true, newSaleNumber: row.sale_number };
}

// ─── Portal data import & matching ────────────────────────────

export type ImportMatchStatus =
  | "MATCHED" | "QTY_MISMATCH" | "SUBSIDY_MISMATCH" | "MISSING_IN_SYSTEM"
  | "CANCELLED_IN_SYSTEM" | "NOT_POSTED" | "DUPLICATE_IN_FILE" | "INVALID";

export interface FmsImportBatch {
  id: string;
  filename: string | null;
  fms_dealer_id: string;
  period_from: string;
  period_to: string;
  total_lines: number;
  matched: number;
  mismatched: number;
  missing_in_system: number;
  cancelled_in_system: number;
  not_posted: number;
  duplicate_in_file: number;
  invalid_lines: number;
  missing_in_portal: number;
  created_at: string;
}

export interface FmsImportLine {
  id: string;
  line_no: number;
  pos_transaction_id: string | null;
  txn_date: string | null;
  farmer_name: string | null;
  fms_product_code: string | null;
  qty: number | null;
  subsidy_amount: number | null;
  ack_no: string | null;
  match_status: ImportMatchStatus;
  matched_sale_id: string | null;
  system_qty: number | null;
  system_subsidy: number | null;
  note: string | null;
}

export interface FmsMissingInPortal {
  sale_id: string;
  sale_number: string;
  sale_date: string;
  farmer_name: string;
  pos_transaction_id: string | null;
  qty_sold: number;
  total_subsidy_amount: number;
  status: string;
}

const ImportSchema = z.object({
  filename:   z.string().max(200).optional().or(z.literal("")),
  dealerId:   z.string().trim().min(1, "FMS dealer ID is required").max(50),
  periodFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Select the period start"),
  periodTo:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Select the period end"),
  lines: z.array(z.object({
    pos_id:       z.string().max(100),
    date:         z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    farmer:       z.string().max(200).optional(),
    product_code: z.string().max(50).optional(),
    qty:          z.number().min(0).max(1e9),
    subsidy:      z.number().min(0).max(1e12),
    ack:          z.string().max(100).optional(),
  })).min(1, "The file contains no transactions").max(20000, "Too many lines (max 20,000 per import)"),
});
export type FmsImportInput = z.infer<typeof ImportSchema>;

export async function importFmsData(input: FmsImportInput) {
  const parsed = ImportSchema.safeParse(input);
  if (!parsed.success) return { success: false as const, error: parsed.error.issues[0]?.message ?? "Invalid import" };
  const d = parsed.data;

  const supabase = createClient();
  const ctx = await getUserContext();
  const { data, error } = await supabase.rpc("import_fms_data", {
    p_organisation_id: ctx.organisationId,
    p_filename:        d.filename || null,
    p_dealer_id:       d.dealerId,
    p_period_from:     d.periodFrom,
    p_period_to:       d.periodTo,
    p_lines:           d.lines,
  });
  if (error) return { success: false as const, error: error.message };

  const batch = data as FmsImportBatch;
  await writeAuditLog({ ctx, action: "FMS_IMPORT", tableName: "fms_import_batches", recordId: batch.id,
    newValues: { lines: batch.total_lines, matched: batch.matched, dealer: d.dealerId } });
  revalidatePath("/fms/import");
  revalidatePath("/fms/ledger");
  return { success: true as const, batch };
}

export async function getFmsImportBatches(): Promise<FmsImportBatch[]> {
  const supabase = createClient();
  const ctx = await getUserContext();
  const { data, error } = await supabase
    .from("fms_import_batches")
    .select("*")
    .eq("organisation_id", ctx.organisationId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(`FMS imports error: ${error.message}`);
  return (data ?? []) as FmsImportBatch[];
}

export async function getFmsImportDetail(batchId: string): Promise<{ lines: FmsImportLine[]; missingInPortal: FmsMissingInPortal[] }> {
  const supabase = createClient();
  const ctx = await getUserContext();

  const { data: b } = await supabase.from("fms_import_batches").select("id")
    .eq("id", batchId).eq("organisation_id", ctx.organisationId).maybeSingle();
  if (!b) throw new Error("Import not found.");

  const [lines, missing] = await Promise.all([
    supabase.from("fms_import_lines").select("*").eq("batch_id", batchId).order("line_no", { ascending: true }).limit(20000),
    supabase.rpc("fms_import_missing_in_portal", { p_batch_id: batchId }),
  ]);
  if (lines.error) throw new Error(`Import lines error: ${lines.error.message}`);
  if (missing.error) throw new Error(`Missing-in-portal error: ${missing.error.message}`);
  return { lines: (lines.data ?? []) as FmsImportLine[], missingInPortal: (missing.data ?? []) as FmsMissingInPortal[] };
}
