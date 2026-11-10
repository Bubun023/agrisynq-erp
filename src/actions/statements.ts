"use server";

import { createClient } from "@/lib/supabase/server";
import { getUserContext } from "./context";
import { buildBalanceSheet, type AccountBalance, type BalanceSheet } from "@/lib/statements";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const n = (v: unknown) => Number(v ?? 0);

export type LedgerRow = { seq: number; txn_date: string; voucher_no: string | null; voucher_type: string | null; particulars: string | null;
                          party_name?: string | null; account_code?: string | null; debit: number; credit: number; running_balance: number };
export type StockValuationRow = { product_id: string; product_name: string; product_code: string | null; category: string; location_id: string | null;
                                  location_name: string | null; batch_id: string | null; batch_number: string | null; expiry_date: string | null;
                                  qty: number; unit_cost: number; value: number };
export type StockAgeingRow = { product_id: string; product_name: string; location_name: string | null; batch_id: string; batch_number: string | null;
                               received_on: string; age_days: number; age_bucket: string; expiry_date: string | null; days_to_expiry: number | null;
                               expiry_status: string; qty: number; value: number };

type Fail = { error: string };
const bad = (e: unknown): Fail => ({ error: e instanceof Error ? e.message : "Could not load the report" });

export async function getBalanceSheet(asOf: string): Promise<{ sheet: BalanceSheet; asOf: string } | Fail> {
  try {
    if (!DATE.test(asOf)) return { error: "Choose a valid date" };
    await getUserContext();
    const { data, error } = await createClient().rpc("rpt_account_balances", { p_as_of: asOf });
    if (error) return { error: error.message };
    const rows = (data ?? []).map((r: AccountBalance) => ({ ...r, balance: n(r.balance) }));
    return { sheet: buildBalanceSheet(rows), asOf };
  } catch (e) { return bad(e); }
}

export async function getAccountOptions(): Promise<{ id: string; code: string; name: string }[]> {
  const ctx = await getUserContext();
  const { data } = await createClient().from("chart_of_accounts").select("id, account_code, account_name")
    .eq("tenant_id", ctx.tenantId).eq("is_active", true).order("account_code");
  return (data ?? []).map((a) => ({ id: a.id, code: a.account_code, name: a.account_name }));
}

export async function getPartyOptions(): Promise<{ id: string; name: string; code: string | null }[]> {
  const ctx = await getUserContext();
  const { data } = await createClient().from("parties").select("id, name, code")
    .eq("tenant_id", ctx.tenantId).eq("organisation_id", ctx.organisationId).order("name");
  return (data ?? []).map((p) => ({ id: p.id, name: p.name, code: p.code }));
}

export async function getAccountLedger(accountId: string, from: string, to: string): Promise<{ rows: LedgerRow[] } | Fail> {
  try {
    if (!UUID.test(accountId)) return { error: "Choose an account" };
    if (!DATE.test(from) || !DATE.test(to)) return { error: "Choose valid dates" };
    if (from > to) return { error: "The start date is after the end date" };
    await getUserContext();
    const { data, error } = await createClient().rpc("rpt_account_ledger", { p_account: accountId, p_from: from, p_to: to });
    if (error) return { error: error.message };
    return { rows: (data ?? []).map((r: LedgerRow) => ({ ...r, seq: n(r.seq), debit: n(r.debit), credit: n(r.credit), running_balance: n(r.running_balance) })) };
  } catch (e) { return bad(e); }
}

export async function getPartyStatement(partyId: string, from: string, to: string): Promise<{ rows: LedgerRow[] } | Fail> {
  try {
    if (!UUID.test(partyId)) return { error: "Choose a party" };
    if (!DATE.test(from) || !DATE.test(to)) return { error: "Choose valid dates" };
    if (from > to) return { error: "The start date is after the end date" };
    await getUserContext();
    const { data, error } = await createClient().rpc("rpt_party_statement", { p_party: partyId, p_from: from, p_to: to });
    if (error) return { error: error.message };
    return { rows: (data ?? []).map((r: LedgerRow) => ({ ...r, seq: n(r.seq), debit: n(r.debit), credit: n(r.credit), running_balance: n(r.running_balance) })) };
  } catch (e) { return bad(e); }
}

export async function getStockValuation(asOf: string): Promise<{ rows: StockValuationRow[]; booksValue: number; inTransit: number } | Fail> {
  try {
    if (!DATE.test(asOf)) return { error: "Choose a valid date" };
    await getUserContext();
    const supabase = createClient();
    const [val, bal, transit] = await Promise.all([
      supabase.rpc("rpt_stock_valuation", { p_as_of: asOf }),
      supabase.rpc("rpt_account_balances", { p_as_of: asOf }),
      supabase.rpc("rpt_stock_in_transit", { p_as_of: asOf }),
    ]);
    if (val.error) return { error: val.error.message };
    if (bal.error) return { error: bal.error.message };
    if (transit.error) return { error: transit.error.message };
    const rows = (val.data ?? []).map((r: StockValuationRow) => ({ ...r, qty: n(r.qty), unit_cost: n(r.unit_cost), value: n(r.value) }));
    const stockAcct = (bal.data ?? []).find((a: AccountBalance) => a.account_code === "1020");
    return { rows, booksValue: n(stockAcct?.balance), inTransit: n(transit.data) };
  } catch (e) { return bad(e); }
}

export async function getStockAgeing(asOf: string): Promise<{ rows: StockAgeingRow[] } | Fail> {
  try {
    if (!DATE.test(asOf)) return { error: "Choose a valid date" };
    await getUserContext();
    const { data, error } = await createClient().rpc("rpt_stock_ageing", { p_as_of: asOf });
    if (error) return { error: error.message };
    return { rows: (data ?? []).map((r: StockAgeingRow) => ({ ...r, qty: n(r.qty), value: n(r.value), age_days: n(r.age_days) })) };
  } catch (e) { return bad(e); }
}
