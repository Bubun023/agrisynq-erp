"use server";

import { createClient } from "@/lib/supabase/server";
import { getUserContext, writeAuditLog } from "./context";
import { revalidatePath } from "next/cache";
import { addParty } from "./parties";
import { addProduct } from "./products";
import { addLocation } from "./locations";
import { addFarmer } from "./farmers";
import { checkOpeningRow, getEntity, normaliseRow, MAX_IMPORT_ROWS, type ImportEntity } from "@/lib/data-import";

export type RowResult = { row: number; ok: boolean; message?: string };
export type MasterImportResult = { error?: string; imported: number; failed: number; results: RowResult[] };

const MASTER: Record<string, (prev: object, fd: FormData) => Promise<{ success?: boolean; error?: string; fieldErrors?: Record<string, string[]> }>> = {
  parties: addParty, products: addProduct, locations: addLocation, farmers: addFarmer,
};
const PATH: Record<string, string> = { parties: "/master-data/parties", products: "/master-data/products", locations: "/master-data/locations", farmers: "/master-data/farmers" };

function friendly(msg: string): string {
  const c = msg.match(/unique constraint "([^"]+)"/);
  if (!c) return msg;
  const field = /gstin/.test(c[1]) ? "GSTIN" : /pan/.test(c[1]) ? "PAN" : /code/.test(c[1]) ? "code" : /name/.test(c[1]) ? "name" : /phone|mobile/.test(c[1]) ? "mobile number" : "details";
  return `Already exists - a record with the same ${field} is already in the system`;
}
function describe(r: { error?: string; fieldErrors?: Record<string, string[]> }): string {
  if (r.fieldErrors) return Object.entries(r.fieldErrors).map(([k, v]) => `${k}: ${v.join(", ")}`).join("; ");
  return friendly(r.error ?? "Could not be saved");
}

/**
 * Master data import: every row goes through the same validated action as the screens (duplicate checks, audit log,
 * tenant scoping). Rows are independent - good rows are saved, bad ones are reported with their file line number so only
 * those need fixing and re-uploading.
 */
export async function importMasterData(entity: ImportEntity, rows: Record<string, string>[]): Promise<MasterImportResult> {
  const empty = { imported: 0, failed: 0, results: [] as RowResult[] };
  try {
    const def = getEntity(entity);
    const action = MASTER[entity];
    if (!def || !action) return { ...empty, error: "Unknown import type" };
    if (!Array.isArray(rows) || rows.length === 0) return { ...empty, error: "There are no rows to import" };
    if (rows.length > MAX_IMPORT_ROWS) return { ...empty, error: `Too many rows - the limit is ${MAX_IMPORT_ROWS} per file` };
    const ctx = await getUserContext();
    if (!ctx.provisioned) return { ...empty, error: "Your account is not set up yet" };

    const results: RowResult[] = [];
    for (let i = 0; i < rows.length; i++) {
      const { row, errors } = normaliseRow(def, rows[i]);          // never trust the browser's cleanup
      if (errors.length) { results.push({ row: i + 2, ok: false, message: errors.join("; ") }); continue; }
      const fd = new FormData();
      for (const [k, v] of Object.entries(row)) if (v !== "") fd.set(k, v);
      if (entity === "parties" && !fd.get("is_customer") && !fd.get("is_supplier")) {   // derive role flags from party_type when not given
        const t = fd.get("party_type");
        if (t === "CUSTOMER" || t === "BOTH") fd.set("is_customer", "true");
        if (t === "SUPPLIER" || t === "BOTH") fd.set("is_supplier", "true");
        if (t === "CF_AGENT") fd.set("is_cf_agent", "true");
      }
      try {
        const r = await action({}, fd);
        results.push(r.success ? { row: i + 2, ok: true } : { row: i + 2, ok: false, message: describe(r) });
      } catch (e) {
        results.push({ row: i + 2, ok: false, message: e instanceof Error ? friendly(e.message) : "Unexpected error" });
      }
    }
    const imported = results.filter((r) => r.ok).length;
    await writeAuditLog({ ctx, action: "IMPORT", tableName: entity, newValues: { imported, failed: results.length - imported } });
    if (PATH[entity]) revalidatePath(PATH[entity]);
    return { imported, failed: results.length - imported, results };
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : "Import failed" };
  }
}

// ─── Opening balances ─────────────────────────────────────────

export type OpeningInput = {
  asOf: string;
  stock: Record<string, string>[];
  parties: Record<string, string>[];
  accounts: Record<string, string>[];
  dryRun: boolean;
};
export type OpeningIssue = { sheet: string; row: number; message: string };
export type OpeningResult = {
  error?: string;
  issues: OpeningIssue[];
  posted: boolean;
  summary?: { stockRows: number; stockValue: number; partyRows: number; accountRows: number; debtors: number; creditors: number; capitalBalancing: number };
};

type Named = { id: string; name: string; code: string | null };
function finder(list: Named[], what: string) {
  const byCode = new Map<string, Named[]>(), byName = new Map<string, Named[]>();
  for (const x of list) {
    if (x.code) byCode.set(x.code.toLowerCase(), [...(byCode.get(x.code.toLowerCase()) ?? []), x]);
    byName.set(x.name.toLowerCase(), [...(byName.get(x.name.toLowerCase()) ?? []), x]);
  }
  return (key: string): { id?: string; error?: string } => {
    const k = key.trim().toLowerCase();
    const hit = byCode.get(k) ?? byName.get(k);
    if (!hit) return { error: `${what} "${key}" not found (use its code or exact name)` };
    if (hit.length > 1) return { error: `${what} "${key}" matches ${hit.length} records - use the code` };
    return { id: hit[0].id };
  };
}

export async function importOpeningBalances(input: OpeningInput): Promise<OpeningResult> {
  const fail = (error: string): OpeningResult => ({ error, issues: [], posted: false });
  try {
    const ctx = await getUserContext();
    if (!ctx.provisioned) return fail("Your account is not set up yet");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.asOf ?? "")) return fail("Choose the opening date");
    const total = input.stock.length + input.parties.length + input.accounts.length;
    if (total === 0) return fail("There is nothing to import");
    if (total > MAX_IMPORT_ROWS * 3) return fail("Too many rows");

    const supabase = createClient();
    const [prod, loc, par] = await Promise.all([
      supabase.from("products").select("id, name, product_code").eq("tenant_id", ctx.tenantId).eq("organisation_id", ctx.organisationId),
      supabase.from("locations").select("id, name, code").eq("tenant_id", ctx.tenantId).eq("organisation_id", ctx.organisationId),
      supabase.from("parties").select("id, name, code").eq("tenant_id", ctx.tenantId).eq("organisation_id", ctx.organisationId),
    ]);
    if (prod.error || loc.error || par.error) return fail("Could not read your master data");
    const findProduct = finder((prod.data ?? []).map((p) => ({ id: p.id, name: p.name, code: p.product_code })), "Product");
    const findLocation = finder((loc.data ?? []).map((l) => ({ id: l.id, name: l.name, code: l.code })), "Location");
    const findParty = finder((par.data ?? []).map((p) => ({ id: p.id, name: p.name, code: p.code })), "Party");

    const issues: OpeningIssue[] = [];
    const add = (sheet: string, i: number, message: string) => issues.push({ sheet, row: i + 2, message });
    const seen = new Set<string>();

    const stock = input.stock.map((raw, i) => {
      const def = getEntity("opening_stock")!;
      const { row, errors } = normaliseRow(def, raw);
      errors.concat(checkOpeningRow("opening_stock", row)).forEach((m) => add("Opening stock", i, m));
      const p = findProduct(row.product ?? ""), l = findLocation(row.location ?? "");
      if (p.error) add("Opening stock", i, p.error);
      if (l.error) add("Opening stock", i, l.error);
      const key = `${p.id}|${row.batch_number?.toLowerCase()}`;
      if (p.id && seen.has(key)) add("Opening stock", i, `batch ${row.batch_number} appears twice for this product`);
      seen.add(key);
      return { product_id: p.id, location_id: l.id, batch_number: row.batch_number, qty: Number(row.qty), rate: Number(row.cost_rate || 0),
               manufacture_date: row.manufacture_date || null, expiry_date: row.expiry_date || null };
    });

    const seenParty = new Set<string>();
    const parties = input.parties.map((raw, i) => {
      const { row, errors } = normaliseRow(getEntity("opening_parties")!, raw);
      errors.concat(checkOpeningRow("opening_parties", row)).forEach((m) => add("Party balances", i, m));
      const p = findParty(row.party ?? "");
      if (p.error) add("Party balances", i, p.error);
      if (p.id && seenParty.has(p.id)) add("Party balances", i, `${row.party} appears twice`);
      if (p.id) seenParty.add(p.id);
      return { party_id: p.id, amount: Number(row.amount), side: row.side || null };
    });

    const seenAcct = new Set<string>();
    const accounts = input.accounts.map((raw, i) => {
      const { row, errors } = normaliseRow(getEntity("opening_accounts")!, raw);
      errors.concat(checkOpeningRow("opening_accounts", row)).forEach((m) => add("Ledger balances", i, m));
      if (seenAcct.has(row.account_code)) add("Ledger balances", i, `account ${row.account_code} appears twice`);
      seenAcct.add(row.account_code);
      return { account_code: row.account_code, debit: Number(row.debit || 0), credit: Number(row.credit || 0) };
    });

    const round2 = (n: number) => Math.round(n * 100) / 100;
    const summary = {
      stockRows: stock.length, stockValue: round2(stock.reduce((s, x) => s + round2(x.qty * x.rate), 0)),
      partyRows: parties.length, accountRows: accounts.length,
      debtors: round2(parties.filter((p) => p.side !== "SUPPLIER" && p.amount > 0).reduce((s, p) => s + p.amount, 0)),
      creditors: round2(parties.filter((p) => p.side === "SUPPLIER" && p.amount > 0).reduce((s, p) => s + p.amount, 0)),
      capitalBalancing: 0,
    };
    if (issues.length) return { issues, posted: false, summary };
    if (input.dryRun) return { issues, posted: false, summary };

    const { data, error } = await supabase.rpc("post_opening_balances", {
      p_org: ctx.organisationId, p_branch: ctx.branchId, p_as_of: input.asOf,
      p_stock: stock, p_parties: parties, p_accounts: accounts,
    });
    if (error) return { error: error.message, issues, posted: false, summary };
    await writeAuditLog({ ctx, action: "IMPORT", tableName: "opening_balances", recordId: (data as { voucher_id?: string })?.voucher_id,
                          newValues: { asOf: input.asOf, ...(data as object) } });
    for (const p of ["/inventory", "/accounting", "/reports"]) revalidatePath(p, "layout");
    return { issues, posted: true, summary: { ...summary, capitalBalancing: Number((data as { capital_balancing?: number }).capital_balancing ?? 0) } };
  } catch (e) {
    return fail(e instanceof Error ? e.message : "Import failed");
  }
}
