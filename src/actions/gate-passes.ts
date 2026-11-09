"use server";

import { createClient } from "@/lib/supabase/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getUserContext, writeAuditLog } from "./context";

export type PassType =
  | "OUTWARD_SALE" | "OUTWARD_TRANSFER" | "OUTWARD_RETURN"
  | "INWARD_PURCHASE" | "INWARD_TRANSFER" | "INWARD_SALES_RETURN";
export type RefDocType = "STOCK_TRANSFER" | "SALE_INVOICE" | "PURCHASE_INVOICE" | "CREDIT_NOTE" | "DELIVERY_CHALLAN";

export interface GatePassRow {
  id: string;
  gate_pass_no: string;
  pass_type: PassType;
  pass_date: string;
  location_id: string;
  location_name: string;
  reference_doc_type: string;
  reference_doc_id: string;
  reference_doc_no: string;
  vehicle_no: string;
  driver_name: string | null;
  driver_mobile: string | null;
  total_packages: number | null;
  security_officer_name: string | null;
  remarks: string | null;
  is_voided: boolean;
  void_reason: string | null;
  voided_at: string | null;
}

export interface PendingPassRow {
  reference_doc_type: RefDocType;
  reference_doc_id: string;
  reference_doc_no: string;
  doc_date: string;
  pass_type: PassType;
  location_id: string;
  location_name: string;
  counterparty: string | null;
}

export async function getGatePasses(): Promise<GatePassRow[]> {
  const supabase = createClient();
  const ctx = await getUserContext();
  const { data, error } = await supabase.from("vw_gate_passes").select("*")
    .eq("organisation_id", ctx.organisationId).order("pass_date", { ascending: false }).limit(500);
  if (error) throw new Error(`Gate passes error: ${error.message}`);
  return (data ?? []) as GatePassRow[];
}

export async function getPendingGatePasses(): Promise<PendingPassRow[]> {
  const supabase = createClient();
  const ctx = await getUserContext();
  const { data, error } = await supabase.from("vw_gate_pass_pending").select("*")
    .eq("organisation_id", ctx.organisationId).order("doc_date", { ascending: false }).limit(500);
  if (error) throw new Error(`Pending gate passes error: ${error.message}`);
  return (data ?? []) as PendingPassRow[];
}

const IssueSchema = z.object({
  referenceType:   z.enum(["STOCK_TRANSFER", "SALE_INVOICE", "PURCHASE_INVOICE", "CREDIT_NOTE", "DELIVERY_CHALLAN"]),
  referenceId:     z.string().uuid(),
  passType:        z.enum(["OUTWARD_SALE", "OUTWARD_TRANSFER", "OUTWARD_RETURN", "INWARD_PURCHASE", "INWARD_TRANSFER", "INWARD_SALES_RETURN"]),
  vehicleNo:       z.string().trim().min(1, "Vehicle number is required").max(20),
  driverName:      z.string().trim().max(100).optional().or(z.literal("")),
  driverMobile:    z.string().trim().max(20).optional().or(z.literal("")),
  totalPackages:   z.number().int().min(0).max(1_000_000).optional(),
  securityOfficer: z.string().trim().max(100).optional().or(z.literal("")),
  remarks:         z.string().trim().max(500).optional().or(z.literal("")),
});
export type IssuePassInput = z.infer<typeof IssueSchema>;

export async function issueGatePass(input: IssuePassInput) {
  const p = IssueSchema.safeParse(input);
  if (!p.success) return { success: false as const, error: p.error.issues[0]?.message ?? "Invalid input" };
  const d = p.data;

  const supabase = createClient();
  const ctx = await getUserContext();
  const { data, error } = await supabase.rpc("issue_gate_pass", {
    p_reference_type:   d.referenceType,
    p_reference_id:     d.referenceId,
    p_pass_type:        d.passType,
    p_vehicle_no:       d.vehicleNo,
    p_driver_name:      d.driverName || null,
    p_driver_mobile:    d.driverMobile || null,
    p_total_packages:   d.totalPackages ?? null,
    p_security_officer: d.securityOfficer || null,
    p_remarks:          d.remarks || null,
  });
  if (error) return { success: false as const, error: error.message };

  const g = data as { id: string; gate_pass_no: string };
  await writeAuditLog({ ctx, action: "GATE_PASS_ISSUE", tableName: "gate_passes", recordId: g.id,
    newValues: { gate_pass_no: g.gate_pass_no, reference: d.referenceType, pass_type: d.passType } });
  revalidatePath("/cf-management/gate-passes");
  return { success: true as const, gatePassNo: g.gate_pass_no };
}

export async function voidGatePass(id: string, reason: string) {
  const supabase = createClient();
  const ctx = await getUserContext();
  const { error } = await supabase.rpc("void_gate_pass", { p_id: id, p_reason: reason });
  if (error) return { success: false as const, error: error.message };
  await writeAuditLog({ ctx, action: "GATE_PASS_VOID", tableName: "gate_passes", recordId: id, reason });
  revalidatePath("/cf-management/gate-passes");
  return { success: true as const };
}
