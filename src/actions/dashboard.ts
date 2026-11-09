"use server";

import { createClient } from "@/lib/supabase/server";
import { getUserContext } from "./context";

export interface DashboardStats {
  todaySales: number;          // posted tax invoices dated today (net receivable)
  salesThisMonth: number;
  overdueAR: number;           // outstanding on posted invoices past due date
  overdueARCount: number;
  payablesDue: number;         // outstanding supplier payables past due date
  transfersInTransit: number;  // stock transfers dispatched, not yet received
  stockOnHandUnits: number;
  stockValue: number;          // balance of Stock-in-Hand (1020)
  expiringBatches: number;     // batches with stock expiring within 60 days
  expiredWithStock: number;
  activeLicences: number;
  licencesExpiring30: number;
  fmsPending: number;          // FMS reconciliations not matched/resolved
  unmatchedBankLines: number;
  draftInvoices: number;       // sales invoices waiting to be posted
  currentPeriod: string;       // e.g. "November 2026"
  currentPeriodLocked: boolean;
  /** Names of queries that failed, so the UI can show partial data honestly instead of fake zeros. */
  failed: string[];
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

export async function getDashboardStats(): Promise<DashboardStats> {
  const supabase = createClient();
  const ctx = await getUserContext();
  const org = ctx.organisationId;

  const now = new Date();
  const today = iso(now);
  const monthStart = iso(new Date(now.getFullYear(), now.getMonth(), 1));
  const plus = (days: number) => iso(new Date(now.getTime() + days * 86400000));
  const failed: string[] = [];

  // Runs one query; on error records the name and returns the fallback (never throws).
  async function q<T>(name: string, run: () => PromiseLike<{ data: T | null; error: { message: string } | null }>, fallback: T): Promise<T> {
    try {
      const { data, error } = await run();
      if (error) { failed.push(name); return fallback; }
      return data ?? fallback;
    } catch {
      failed.push(name);
      return fallback;
    }
  }

  const sum = <R,>(rows: R[], f: (r: R) => number) => rows.reduce((a, r) => a + (Number(f(r)) || 0), 0);

  const [
    salesMonth, ar, ap, transfers, stock, trial, expiring, expired, licences, fms, bank, drafts, locks,
  ] = await Promise.all([
    q("sales", () => supabase.from("sales_invoices").select("invoice_date, net_receivable")
      .eq("organisation_id", org).eq("status", "POSTED").gte("invoice_date", monthStart), [] as { invoice_date: string; net_receivable: number }[]),
    q("receivables", () => supabase.from("vw_ageing_receivables").select("outstanding, days_overdue")
      .eq("organisation_id", org).gt("days_overdue", 0), [] as { outstanding: number; days_overdue: number }[]),
    q("payables", () => supabase.from("vw_ageing_payables").select("outstanding")
      .eq("organisation_id", org).gt("days_overdue", 0), [] as { outstanding: number }[]),
    q("transfers", () => supabase.from("stock_transfers").select("id")
      .eq("organisation_id", org).eq("status", "IN_TRANSIT"), [] as { id: string }[]),
    q("stock", () => supabase.from("stock_balance").select("balance_qty")
      .eq("organisation_id", org), [] as { balance_qty: number }[]),
    q("stock value", () => supabase.from("vw_trial_balance").select("period_debit, period_credit, opening_balance, opening_balance_type")
      .eq("tenant_id", ctx.tenantId).eq("account_code", "1020"),
      [] as { period_debit: number; period_credit: number; opening_balance: number; opening_balance_type: string }[]),
    q("expiring batches", () => supabase.from("batch_register").select("id")
      .eq("organisation_id", org).gt("current_qty", 0).gte("expiry_date", today).lte("expiry_date", plus(60)), [] as { id: string }[]),
    q("expired batches", () => supabase.from("batch_register").select("id")
      .eq("organisation_id", org).gt("current_qty", 0).lt("expiry_date", today), [] as { id: string }[]),
    q("licences", () => supabase.from("licences").select("valid_to")
      .eq("organisation_id", org).eq("is_active", true).eq("status", "ACTIVE"), [] as { valid_to: string | null }[]),
    q("fms", () => supabase.from("fms_reconciliation").select("id")
      .eq("organisation_id", org).in("reconciliation_status", ["PENDING", "VARIANCE"]), [] as { id: string }[]),
    q("bank", () => supabase.from("vw_bank_account_balance").select("unmatched_count")
      .eq("organisation_id", org).eq("is_active", true), [] as { unmatched_count: number }[]),
    q("drafts", () => supabase.from("sales_invoices").select("id")
      .eq("organisation_id", org).eq("status", "DRAFT"), [] as { id: string }[]),
    q("period lock", () => supabase.from("period_locks").select("id")
      .eq("organisation_id", org).eq("lock_type", "FINANCIAL").eq("is_locked", true)
      .lte("period_from", today).gte("period_to", today), [] as { id: string }[]),
  ]);

  const stockValue = sum(trial, (r) =>
    (r.opening_balance_type === "CR" ? -Number(r.opening_balance) : Number(r.opening_balance))
    + Number(r.period_debit) - Number(r.period_credit));

  return {
    todaySales: sum(salesMonth.filter((r) => r.invoice_date === today), (r) => r.net_receivable),
    salesThisMonth: sum(salesMonth, (r) => r.net_receivable),
    overdueAR: sum(ar, (r) => r.outstanding),
    overdueARCount: ar.length,
    payablesDue: sum(ap, (r) => r.outstanding),
    transfersInTransit: transfers.length,
    stockOnHandUnits: sum(stock, (r) => r.balance_qty),
    stockValue,
    expiringBatches: expiring.length,
    expiredWithStock: expired.length,
    activeLicences: licences.length,
    licencesExpiring30: licences.filter((l) => l.valid_to && l.valid_to >= today && l.valid_to <= plus(30)).length,
    fmsPending: fms.length,
    unmatchedBankLines: sum(bank, (r) => r.unmatched_count),
    draftInvoices: drafts.length,
    currentPeriod: now.toLocaleString("en-IN", { month: "long", year: "numeric" }),
    currentPeriodLocked: locks.length > 0,
    failed,
  };
}
