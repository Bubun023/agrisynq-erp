'use server';

import { createClient } from '@/lib/supabase/server';
import { getUserContext } from '@/actions/context';

// ─── Types ────────────────────────────────────────────────────

export type PLRow = {
  fyear: number;
  fmonth: number;
  account_type: 'INCOME' | 'EXPENSE';
  account_code: string;
  account_name: string;
  net_amount: number;
};

export type AgeingRow = {
  party_id: string;
  party_name: string;
  gstin: string | null;
  invoice_no: string;
  invoice_date: string;
  due_date: string | null;
  total_amount: number;
  amount_paid: number;
  outstanding: number;
  days_overdue: number;
  ageing_bucket: 'NOT_DUE' | '1_30' | '31_60' | '61_90' | 'OVER_90';
};

export type DayBookRow = {
  txn_date: string;
  ref_no: string;
  doc_type: string;
  description: string;
  debit_amount: number;
  credit_amount: number;
};

export type StockSummaryReportRow = {
  product_id: string;
  product_name: string;
  product_code: string;
  hsn_sac_code: string | null;
  location_id: string | null;
  location_name: string | null;
  qty_on_hand: number;
};

// ─── P&L Report ───────────────────────────────────────────────

export async function getPLReport(filters: { fromMonth: string; toMonth: string }) {
  const supabase = createClient();
  const ctx = await getUserContext();

  // fromMonth / toMonth format: YYYY-MM
  const [fromYear, fromMon] = filters.fromMonth.split('-').map(Number);
  const [toYear,   toMon  ] = filters.toMonth.split('-').map(Number);

  const { data, error } = await supabase
    .from('vw_pl_summary')
    .select('*')
    .eq('organisation_id', ctx.organisationId)
    .or(
      `and(fyear.gt.${fromYear}),` +
      `and(fyear.eq.${fromYear},fmonth.gte.${fromMon})`
    )
    .order('account_type', { ascending: true })
    .order('account_code',  { ascending: true });

  if (error) throw new Error(`P&L error: ${error.message}`);

  // Filter to month range in JS (Supabase or() with AND subqueries is complex)
  const rows = (data as PLRow[]).filter(r => {
    const rDate = r.fyear * 100 + r.fmonth;
    const fDate = fromYear * 100 + fromMon;
    const tDate = toYear   * 100 + toMon;
    return rDate >= fDate && rDate <= tDate;
  });

  return rows;
}

// ─── Ageing — Receivables ─────────────────────────────────────

export async function getAgeingReceivables(partyId?: string) {
  const supabase = createClient();
  const ctx = await getUserContext();

  let query = supabase
    .from('vw_ageing_receivables')
    .select('*')
    .eq('organisation_id', ctx.organisationId)
    .order('days_overdue', { ascending: false });

  if (partyId) query = query.eq('party_id', partyId);

  const { data, error } = await query;
  if (error) throw new Error(`AR Ageing error: ${error.message}`);
  return data as AgeingRow[];
}

// ─── Ageing — Payables ────────────────────────────────────────

export async function getAgeingPayables(partyId?: string) {
  const supabase = createClient();
  const ctx = await getUserContext();

  let query = supabase
    .from('vw_ageing_payables')
    .select('*')
    .eq('organisation_id', ctx.organisationId)
    .order('days_overdue', { ascending: false });

  if (partyId) query = query.eq('party_id', partyId);

  const { data, error } = await query;
  if (error) throw new Error(`AP Ageing error: ${error.message}`);
  return data as AgeingRow[];
}

// ─── Day Book ─────────────────────────────────────────────────

export async function getDayBook(filters: { fromDate: string; toDate: string; docType?: string }) {
  const supabase = createClient();
  const ctx = await getUserContext();

  let query = supabase
    .from('vw_day_book')
    .select('*')
    .eq('organisation_id', ctx.organisationId)
    .gte('txn_date', filters.fromDate)
    .lte('txn_date', filters.toDate)
    .order('txn_date', { ascending: false })
    .order('ref_no',   { ascending: true });

  if (filters.docType) query = query.eq('doc_type', filters.docType);

  const { data, error } = await query.limit(1000);
  if (error) throw new Error(`Day book error: ${error.message}`);
  return data as DayBookRow[];
}

// ─── Stock Summary Report ─────────────────────────────────────

export async function getStockSummaryReport() {
  const supabase = createClient();
  const ctx = await getUserContext();

  const { data, error } = await supabase
    .from('vw_stock_summary')
    .select('*')
    .eq('organisation_id', ctx.organisationId)
    .order('product_name', { ascending: true });

  if (error) throw new Error(`Stock summary error: ${error.message}`);
  return data as StockSummaryReportRow[];
}

// ─── GST Summary Report ───────────────────────────────────────

export async function getGstSummaryReport(period: string) {
  const supabase = createClient();
  const ctx = await getUserContext();

  const { data, error } = await supabase
    .from('vw_gstr3b_summary')
    .select('*')
    .eq('organisation_id', ctx.organisationId)
    .eq('return_period', period);

  if (error) throw new Error(`GST Summary error: ${error.message}`);
  return data;
}
