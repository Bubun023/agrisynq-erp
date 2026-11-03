'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { getUserContext, writeAuditLog } from '@/actions/context';

// ============================================================
// TYPES
// ============================================================
export interface GstSalesRow {
  id: string;
  invoice_number: string;
  invoice_date: string;
  return_period: string;
  invoice_type: string;
  sale_type: string | null;
  status: string;
  customer_name: string | null;
  customer_gstin: string | null;
  buyer_state_code: string | null;
  place_of_supply: string | null;
  is_interstate: boolean;
  is_reverse_charge: boolean;
  taxable_amount: number;
  cgst_amount: number;
  sgst_amount: number;
  igst_amount: number;
  cess_amount: number;
  total_gst_amount: number;
  net_receivable: number;
  irn: string | null;
  irn_status: string | null;
  eway_bill_no: string | null;
  gstr1_section: string;
  posted_at: string | null;
}

export interface GstPurchaseRow {
  id: string;
  invoice_number: string;
  invoice_date: string;
  return_period: string;
  invoice_type: string | null;
  status: string;
  supplier_name: string | null;
  supplier_gstin: string | null;
  place_of_supply: string | null;
  is_interstate: boolean;
  is_reverse_charge: boolean;
  taxable_amount: number;
  cgst_amount: number;
  sgst_amount: number;
  igst_amount: number;
  cess_amount: number;
  total_gst_amount: number;
  total_payable: number;
  itc_cgst: number;
  itc_sgst: number;
  itc_igst: number;
  itc_cess: number;
  total_itc_claimed: number;
  itc_reversal_reason: string | null;
  posted_at: string | null;
}

export interface Gstr3bRow {
  org_id: string;
  return_period: string;
  taxable_sales: number;
  cgst_on_sales: number;
  sgst_on_sales: number;
  igst_on_sales: number;
  cess_on_sales: number;
  export_value: number;
  rcm_inward_taxable: number;
  rcm_tax_payable: number;
  itc_igst: number;
  itc_cgst: number;
  itc_sgst: number;
  itc_cess: number;
  total_itc: number;
  net_cgst_payable: number;
  net_sgst_payable: number;
  net_igst_payable: number;
}

export interface Gstr2bImport {
  id: string;
  return_period: string;
  gstin: string;
  imported_at: string;
  total_invoices: number;
  total_itc_igst: number;
  total_itc_cgst: number;
  total_itc_sgst: number;
  status: string;
}

export interface Gstr2bItem {
  id: string;
  import_id: string;
  org_id: string;
  return_period: string;
  supplier_gstin: string;
  supplier_name: string | null;
  invoice_number: string;
  invoice_date: string;
  invoice_type: string | null;
  place_of_supply?: string | null;
  irn?: string | null;
  taxable_value: number;
  igst_amount: number;
  cgst_amount: number;
  sgst_amount: number;
  cess_amount: number;
  total_itc: number;
  itc_availability: string;
  recon_status: string;
  matched_invoice_id: string | null;
  mismatch_notes: string | null;
}

export interface ReturnPeriod {
  id: string;
  gstin: string;
  return_period: string;
  return_type: string;
  status: string;
  due_date: string | null;
  filed_at: string | null;
  reference_arn: string | null;
  notes: string | null;
}

// ============================================================
// GST SALES REGISTER
// ============================================================
export async function getGstSalesRegister(period?: string): Promise<GstSalesRow[]> {
  const supabase = createClient();
  const ctx = await getUserContext();
  let q = supabase
    .from('vw_gst_sales_register')
    .select('*')
    .eq('org_id', ctx.organisationId)
    .order('invoice_date', { ascending: false });
  if (period) q = q.eq('return_period', period);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as GstSalesRow[];
}

// ============================================================
// GST PURCHASE REGISTER
// ============================================================
export async function getGstPurchaseRegister(period?: string): Promise<GstPurchaseRow[]> {
  const supabase = createClient();
  const ctx = await getUserContext();
  let q = supabase
    .from('vw_gst_purchase_register')
    .select('*')
    .eq('org_id', ctx.organisationId)
    .order('invoice_date', { ascending: false });
  if (period) q = q.eq('return_period', period);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as GstPurchaseRow[];
}

// ============================================================
// GSTR-1 BUILDER — outward supply grouped by section
// ============================================================
export async function getGstr1Data(period: string): Promise<{
  period: string;
  b2b: GstSalesRow[];
  b2cl: GstSalesRow[];
  b2cs: GstSalesRow[];
  exp: GstSalesRow[];
  rcm: GstSalesRow[];
  cdnr: GstSalesRow[];
  totals: {
    taxable: number; cgst: number; sgst: number; igst: number; cess: number; invoices: number;
  };
}> {
  const rows = await getGstSalesRegister(period);
  const b2b  = rows.filter(r => r.gstr1_section === 'B2B');
  const b2cl = rows.filter(r => r.gstr1_section === 'B2CL');
  const b2cs = rows.filter(r => r.gstr1_section === 'B2CS');
  const exp  = rows.filter(r => r.gstr1_section === 'EXP' || r.gstr1_section === 'SEZ');
  const rcm  = rows.filter(r => r.gstr1_section === 'B2B_RCM');
  const cdnr: GstSalesRow[] = []; // credit notes — future
  const sum = (arr: GstSalesRow[], k: keyof GstSalesRow) =>
    arr.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  return {
    period,
    b2b, b2cl, b2cs, exp, rcm, cdnr,
    totals: {
      taxable:  sum(rows, 'taxable_amount'),
      cgst:     sum(rows, 'cgst_amount'),
      sgst:     sum(rows, 'sgst_amount'),
      igst:     sum(rows, 'igst_amount'),
      cess:     sum(rows, 'cess_amount'),
      invoices: rows.length,
    },
  };
}

// ============================================================
// GSTR-3B SUMMARY
// ============================================================
export async function getGstr3bSummary(period?: string): Promise<Gstr3bRow[]> {
  const supabase = createClient();
  const ctx = await getUserContext();
  let q = supabase
    .from('vw_gstr3b_summary')
    .select('*')
    .eq('org_id', ctx.organisationId)
    .order('return_period', { ascending: false });
  if (period) q = q.eq('return_period', period);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as Gstr3bRow[];
}

// ============================================================
// RETURN PERIODS
// ============================================================
export async function getReturnPeriods(type?: string): Promise<ReturnPeriod[]> {
  const supabase = createClient();
  const ctx = await getUserContext();
  let q = supabase
    .from('gst_return_periods')
    .select('*')
    .eq('org_id', ctx.organisationId)
    .order('return_period', { ascending: false });
  if (type) q = q.eq('return_type', type);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as ReturnPeriod[];
}

export async function markReturnFiled(
  id: string,
  arn: string,
  notes?: string
): Promise<{ success: boolean; error?: string }> {
  const supabase = createClient();
  const ctx = await getUserContext();
  const { error } = await supabase
    .from('gst_return_periods')
    .update({
      status: 'FILED',
      filed_at: new Date().toISOString(),
      reference_arn: arn,
      notes: notes ?? null,
    })
    .eq('id', id)
    .eq('org_id', ctx.organisationId);
  if (error) return { success: false, error: error.message };
  await writeAuditLog({ ctx, action: 'MARK_FILED', tableName: 'gst_return_periods', recordId: id, newValues: { arn } });
  revalidatePath('/gst');
  return { success: true };
}

// ============================================================
// GSTR-2B IMPORTS
// ============================================================
export async function getGstr2bImports(): Promise<Gstr2bImport[]> {
  const supabase = createClient();
  const ctx = await getUserContext();
  const { data, error } = await supabase
    .from('gstr2b_imports')
    .select('*')
    .eq('org_id', ctx.organisationId)
    .order('imported_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as Gstr2bImport[];
}

export async function getGstr2bItems(importId: string): Promise<Gstr2bItem[]> {
  const supabase = createClient();
  const ctx = await getUserContext();
  const { data, error } = await supabase
    .from('gstr2b_items')
    .select('*')
    .eq('import_id', importId)
    .eq('org_id', ctx.organisationId)
    .order('supplier_gstin');
  if (error) throw new Error(error.message);
  return (data ?? []) as Gstr2bItem[];
}

export async function importGstr2bJson(
  returnPeriod: string,
  gstin: string,
  jsonData: Record<string, unknown>
): Promise<{ success: boolean; importId?: string; error?: string }> {
  const supabase = createClient();
  const ctx = await getUserContext();

  // Parse GSTN portal JSON format
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b2bEntries: any[] = (jsonData as any)?.data?.docdata?.b2b ?? [];
  const items: Omit<Gstr2bItem, 'id' | 'import_id' | 'total_itc'>[] = [];

  for (const supplier of b2bEntries) {
    const sgstin: string = supplier.ctin ?? '';
    const sname: string  = supplier.trdnm ?? '';
    for (const inv of (supplier.inv ?? [])) {
      for (const item of (inv.items ?? [{}])) {
        items.push({
          org_id:            ctx.organisationId,
          return_period:     returnPeriod,
          supplier_gstin:    sgstin,
          supplier_name:     sname,
          invoice_number:    inv.inum ?? '',
          invoice_date:      inv.dt   ?? new Date().toISOString().slice(0,10),
          invoice_type:      'B2B',
          place_of_supply:   inv.pos  ?? '',
          irn:               inv.irn  ?? null,
          taxable_value:     Number(item.txval ?? 0),
          igst_amount:       Number(item.iamt  ?? 0),
          cgst_amount:       Number(item.camt  ?? 0),
          sgst_amount:       Number(item.samt  ?? 0),
          cess_amount:       Number(item.csamt ?? 0),
          itc_availability:  inv.itcavl === 'N' ? 'NO' : 'YES',
          recon_status:      'UNMATCHED',
          matched_invoice_id: null,
          mismatch_notes:    null,
        });
      }
    }
  }

  const { data: importRow, error: impErr } = await supabase
    .from('gstr2b_imports')
    .insert({
      org_id:          ctx.organisationId,
      return_period:   returnPeriod,
      gstin,
      imported_by:     ctx.userId,
      total_invoices:  items.length,
      total_itc_igst:  items.reduce((a, i) => a + i.igst_amount, 0),
      total_itc_cgst:  items.reduce((a, i) => a + i.cgst_amount, 0),
      total_itc_sgst:  items.reduce((a, i) => a + i.sgst_amount, 0),
      raw_json:        jsonData,
    })
    .select('id')
    .single();

  if (impErr || !importRow) return { success: false, error: impErr?.message };

  if (items.length > 0) {
    const { error: itemErr } = await supabase
      .from('gstr2b_items')
      .insert(items.map(it => ({ ...it, import_id: importRow.id })));
    if (itemErr) return { success: false, error: itemErr.message };
  }

  await writeAuditLog({ ctx, action: 'IMPORT_GSTR2B', tableName: 'gstr2b_imports', recordId: importRow.id });
  revalidatePath('/gst/gstr2b');
  return { success: true, importId: importRow.id };
}

export async function runGstr2bReconciliation(
  importId: string
): Promise<{ success: boolean; matched?: number; mismatched?: number; unmatched?: number; error?: string }> {
  const supabase = createClient();
  const ctx = await getUserContext();
  const { data, error } = await supabase.rpc('reconcile_gstr2b', { p_import_id: importId });
  if (error) return { success: false, error: error.message };
  const r = Array.isArray(data) ? data[0] : data;
  await writeAuditLog({ ctx, action: 'RECONCILE_GSTR2B', tableName: 'gstr2b_imports', recordId: importId });
  revalidatePath('/gst/gstr2b');
  return {
    success: true,
    matched:    r?.matched    ?? 0,
    mismatched: r?.mismatched ?? 0,
    unmatched:  r?.unmatched  ?? 0,
  };
}

