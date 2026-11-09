"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getUserContext, writeAuditLog } from "./context";

export type ClaimStatus = "DRAFT" | "SUBMITTED" | "PARTIALLY_RECEIVED" | "FULLY_RECEIVED" | "REJECTED" | "CANCELLED";

export interface SubsidyClaim {
  id: string;
  claim_number: string;
  claim_date: string;
  period_from: string;
  period_to: string;
  subsidy_type: string;
  scheme_name: string | null;
  total_qty_claimed: number;
  total_subsidy_claimed: number;
  subsidy_received: number;
  subsidy_pending: number;
  claim_status: ClaimStatus;
  submitted_on: string | null;
  government_ref_no: string | null;
  rejection_reason: string | null;
  sale_count: number;
  receipt_count: number;
}

export interface SubsidyOverview {
  unclaimedAmount: number;
  unclaimedSales: number;
  unclaimedByType: { type: string; amount: number; sales: number }[];
  awaitingReceipt: number;       // submitted, not yet received
  receivedTotal: number;
}

export interface ClaimSale {
  id: string; sale_number: string; sale_date: string; farmer_name: string;
  pos_transaction_id: string | null; qty_sold: number; total_subsidy_amount: number; status: string;
}
export interface ClaimReceipt {
  id: string; receipt_date: string; amount: number; reference_no: string | null; created_at: string;
}
export interface BankAccountOption { id: string; account_code: string; account_name: string }

export async function getSubsidyOverview(): Promise<SubsidyOverview> {
  const supabase = createClient();
  const ctx = await getUserContext();

  const [unclaimed, claims] = await Promise.all([
    supabase.from("farmer_sales").select("subsidy_type, total_subsidy_amount")
      .eq("tenant_id", ctx.tenantId).eq("organisation_id", ctx.organisationId)
      .eq("status", "POSTED").is("subsidy_claim_id", null).gt("total_subsidy_amount", 0).limit(20000),
    supabase.from("subsidy_claims").select("claim_status, subsidy_pending, subsidy_received")
      .eq("tenant_id", ctx.tenantId).eq("organisation_id", ctx.organisationId),
  ]);
  if (unclaimed.error) throw new Error(`Subsidy overview error: ${unclaimed.error.message}`);
  if (claims.error) throw new Error(`Subsidy overview error: ${claims.error.message}`);

  const byType = new Map<string, { amount: number; sales: number }>();
  let unclaimedAmount = 0;
  for (const r of unclaimed.data ?? []) {
    const t = String(r.subsidy_type);
    const e = byType.get(t) ?? { amount: 0, sales: 0 };
    e.amount += Number(r.total_subsidy_amount); e.sales += 1;
    byType.set(t, e);
    unclaimedAmount += Number(r.total_subsidy_amount);
  }
  const live = (claims.data ?? []).filter((c) => ["SUBMITTED", "PARTIALLY_RECEIVED"].includes(c.claim_status));
  return {
    unclaimedAmount,
    unclaimedSales: (unclaimed.data ?? []).length,
    unclaimedByType: Array.from(byType.entries()).map(([type, v]) => ({ type, ...v })),
    awaitingReceipt: live.reduce((s, c) => s + Number(c.subsidy_pending), 0),
    receivedTotal: (claims.data ?? []).reduce((s, c) => s + Number(c.subsidy_received), 0),
  };
}

export async function getSubsidyClaims(): Promise<SubsidyClaim[]> {
  const supabase = createClient();
  const ctx = await getUserContext();
  const { data, error } = await supabase.from("vw_subsidy_claims").select("*")
    .eq("organisation_id", ctx.organisationId).order("created_at", { ascending: false }).limit(300);
  if (error) throw new Error(`Subsidy claims error: ${error.message}`);
  return (data ?? []) as SubsidyClaim[];
}

export async function getSubsidyClaimDetail(claimId: string): Promise<{ sales: ClaimSale[]; receipts: ClaimReceipt[] }> {
  const supabase = createClient();
  const ctx = await getUserContext();
  const [sales, receipts] = await Promise.all([
    supabase.from("farmer_sales")
      .select("id, sale_number, sale_date, farmer_name, pos_transaction_id, qty_sold, total_subsidy_amount, status")
      .eq("tenant_id", ctx.tenantId).eq("subsidy_claim_id", claimId).order("sale_date").limit(5000),
    supabase.from("subsidy_receipts").select("id, receipt_date, amount, reference_no, created_at")
      .eq("tenant_id", ctx.tenantId).eq("claim_id", claimId).order("receipt_date"),
  ]);
  if (sales.error) throw new Error(sales.error.message);
  if (receipts.error) throw new Error(receipts.error.message);
  return { sales: (sales.data ?? []) as ClaimSale[], receipts: (receipts.data ?? []) as ClaimReceipt[] };
}

export async function getBankAccountOptions(): Promise<BankAccountOption[]> {
  const supabase = createClient();
  const ctx = await getUserContext();
  const { data, error } = await supabase.from("chart_of_accounts")
    .select("id, account_code, account_name")
    .eq("tenant_id", ctx.tenantId).eq("organisation_id", ctx.organisationId)
    .eq("account_type", "ASSET").eq("is_active", true).in("control_type", ["BANK", "CASH"])
    .order("account_code");
  if (error) throw new Error(error.message);
  return (data ?? []) as BankAccountOption[];
}

// ─── Mutations (all enforced by database functions, migration 043) ─────────

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter a valid date");

const CreateSchema = z.object({
  periodFrom: iso, periodTo: iso,
  subsidyType: z.enum(["NEEM_COATED_UREA", "NBS_FERTILIZER", "STATE_SUBSIDY"]),
  schemeName: z.string().trim().max(200).optional().or(z.literal("")),
});
export async function createSubsidyClaim(input: z.infer<typeof CreateSchema>) {
  const p = CreateSchema.safeParse(input);
  if (!p.success) return { success: false as const, error: p.error.issues[0]?.message ?? "Invalid input" };
  const supabase = createClient();
  const ctx = await getUserContext();
  const { data, error } = await supabase.rpc("create_subsidy_claim", {
    p_organisation_id: ctx.organisationId, p_period_from: p.data.periodFrom, p_period_to: p.data.periodTo,
    p_subsidy_type: p.data.subsidyType, p_scheme_name: p.data.schemeName || null,
  });
  if (error) return { success: false as const, error: error.message };
  const c = data as SubsidyClaim;
  await writeAuditLog({ ctx, action: "SUBSIDY_CLAIM_CREATE", tableName: "subsidy_claims", recordId: c.id,
    newValues: { claim_number: c.claim_number, amount: c.total_subsidy_claimed } });
  revalidatePath("/fms/subsidy");
  return { success: true as const, claim: c };
}

export async function submitSubsidyClaim(claimId: string, submittedOn: string, governmentRef: string) {
  const d = iso.safeParse(submittedOn);
  if (!d.success) return { success: false as const, error: "Enter the submission date" };
  const supabase = createClient();
  const ctx = await getUserContext();
  const { error } = await supabase.rpc("submit_subsidy_claim", {
    p_claim_id: claimId, p_submitted_on: submittedOn, p_government_ref: governmentRef || null,
  });
  if (error) return { success: false as const, error: error.message };
  await writeAuditLog({ ctx, action: "SUBSIDY_CLAIM_SUBMIT", tableName: "subsidy_claims", recordId: claimId, newValues: { government_ref: governmentRef } });
  revalidatePath("/fms/subsidy"); revalidatePath("/fms/ledger");
  return { success: true as const };
}

const ReceiptSchema = z.object({
  claimId: z.string().uuid(),
  amount: z.number().positive("Amount must be greater than 0"),
  date: iso,
  accountId: z.string().uuid().optional().or(z.literal("")),
  reference: z.string().trim().max(100).optional().or(z.literal("")),
});
export async function recordSubsidyReceipt(input: z.infer<typeof ReceiptSchema>) {
  const p = ReceiptSchema.safeParse(input);
  if (!p.success) return { success: false as const, error: p.error.issues[0]?.message ?? "Invalid input" };
  const supabase = createClient();
  const ctx = await getUserContext();
  const { error } = await supabase.rpc("record_subsidy_receipt", {
    p_claim_id: p.data.claimId, p_amount: Math.round(p.data.amount * 100) / 100, p_date: p.data.date,
    p_account_id: p.data.accountId || null, p_reference: p.data.reference || null,
  });
  if (error) return { success: false as const, error: error.message };
  await writeAuditLog({ ctx, action: "SUBSIDY_RECEIPT", tableName: "subsidy_claims", recordId: p.data.claimId,
    newValues: { amount: p.data.amount, reference: p.data.reference } });
  revalidatePath("/fms/subsidy"); revalidatePath("/fms/ledger"); revalidatePath("/accounting/trial-balance");
  return { success: true as const };
}

export async function rejectSubsidyClaim(claimId: string, reason: string) {
  const supabase = createClient();
  const ctx = await getUserContext();
  const { error } = await supabase.rpc("reject_subsidy_claim", { p_claim_id: claimId, p_reason: reason });
  if (error) return { success: false as const, error: error.message };
  await writeAuditLog({ ctx, action: "SUBSIDY_CLAIM_REJECT", tableName: "subsidy_claims", recordId: claimId, reason });
  revalidatePath("/fms/subsidy");
  return { success: true as const };
}

export async function cancelSubsidyClaim(claimId: string) {
  const supabase = createClient();
  const ctx = await getUserContext();
  const { error } = await supabase.rpc("cancel_subsidy_claim", { p_claim_id: claimId });
  if (error) return { success: false as const, error: error.message };
  await writeAuditLog({ ctx, action: "SUBSIDY_CLAIM_CANCEL", tableName: "subsidy_claims", recordId: claimId });
  revalidatePath("/fms/subsidy");
  return { success: true as const };
}
