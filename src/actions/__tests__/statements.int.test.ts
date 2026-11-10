/** Statement reports against the real database: balance sheet, account ledger, party statement, stock valuation and ageing. */
import { beforeAll, describe, expect, it } from "vitest";
import { signInAs, actAs } from "@/test/int/session";
import { admin, tag, today, form, mustSucceed, tenantId, idByName, glBalance, seedStock } from "@/test/int/helpers";
import { addParty } from "@/actions/parties";
import { createSalesInvoice, postSalesInvoice } from "@/actions/sales-invoices";
import { createPaymentReceipt, postPaymentReceipt } from "@/actions/accounting";
import { importOpeningBalances } from "@/actions/data-import";
import { getBalanceSheet, getAccountLedger, getPartyStatement, getStockValuation, getStockAgeing, getAccountOptions, getPartyOptions } from "@/actions/statements";

const ids = {} as Record<string, string>;
let stock: Awaited<ReturnType<typeof seedStock>>;
const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
const r2 = (n: number) => Math.round(n * 100) / 100;

function ok<T extends object>(r: T | { error: string }): T {
  if ("error" in r) throw new Error(r.error);
  return r;
}

beforeAll(async () => {
  for (const u of ["admin", "viewer"] as const) await signInAs(u);
  actAs("admin");
  mustSucceed(await addParty({}, form({ name: `Stmt Cust ${tag}`, code: `SC${tag}`, party_type: "CUSTOMER", is_customer: true, gst_status: "UNREGISTERED" })), "addParty");
  ids.customer = await idByName("parties", `Stmt Cust ${tag}`);
  stock = await seedStock("ST", 100, 10);

  // 5,000 brought forward on 1 Jan 2020, then a 10-bag credit sale (3,150 with GST) and a 1,000 receipt today
  const ob = await importOpeningBalances({ asOf: "2020-01-01", dryRun: false, stock: [], accounts: [], parties: [{ party: `SC${tag}`, amount: "5000", side: "" }] });
  if (ob.error || !ob.posted) throw new Error(`opening balance failed: ${ob.error ?? JSON.stringify(ob.issues)}`);
  const si = await createSalesInvoice({}, form({ invoice_date: today, sale_type: "CREDIT", customer_id: ids.customer, from_location: stock.location, is_interstate: false },
    [{ product_id: stock.product, hsn_code: "3102", batch_id: stock.batch, qty: 10, unit_of_measure: "BAG", unit_price: 300, gst_rate: 5 }]));
  mustSucceed(si, "createSalesInvoice");
  mustSucceed(await postSalesInvoice(si.invoiceId!), "postSalesInvoice");
  const rc = await createPaymentReceipt({ receipt_no: `ST-${tag}`, receipt_date: today, receipt_type: "RECEIPT", party_id: ids.customer, payment_mode: "UPI", amount: 1000, utr_no: `U${tag}`, bank_account_id: "" } as Parameters<typeof createPaymentReceipt>[0]);
  mustSucceed(rc, "createPaymentReceipt");
  mustSucceed(await postPaymentReceipt((rc.data as { id: string }).id), "postPaymentReceipt");
});

describe("party statement", () => {
  it("shows brought-forward, the sale and the receipt with a running balance", async () => {
    const { rows } = ok(await getPartyStatement(ids.customer, "2020-06-01", today));
    expect(rows.map((r) => [r.particulars === "Brought forward" ? "BF" : r.voucher_type, r.debit, r.credit, r.running_balance])).toEqual([
      ["BF", 5000, 0, 5000],
      ["SALES", 3150, 0, 8150],
      ["RECEIPT", 0, 1000, 7150],
    ]);
  });
  it("a window before everything starts at zero; one covering the opening entry lists it", async () => {
    const early = ok(await getPartyStatement(ids.customer, "2019-01-01", "2019-12-31")).rows;
    expect(early).toHaveLength(1);
    expect(early[0].running_balance).toBe(0);
    const all = ok(await getPartyStatement(ids.customer, "2019-01-01", today)).rows;
    expect(all[0].running_balance).toBe(0);
    expect(all.at(-1)!.running_balance).toBe(7150);
    expect(all.some((r) => r.voucher_type === "JOURNAL" && r.debit === 5000)).toBe(true);
  });
  it("matches the outstanding invoice balance plus the brought-forward amount", async () => {
    const inv = await admin.from("sales_invoices").select("outstanding_amount").eq("customer_id", ids.customer).eq("status", "POSTED");
    const outstanding = (inv.data ?? []).reduce((a, r) => a + Number(r.outstanding_amount), 0);
    const last = ok(await getPartyStatement(ids.customer, "2019-01-01", today)).rows.at(-1)!.running_balance;
    // the 1,000 receipt auto-allocates to the invoice, so statement balance = 5,000 brought forward + invoice outstanding
    expect(r2(last)).toBe(r2(5000 + outstanding));
  });
  it("rejects bad input", async () => {
    expect("error" in (await getPartyStatement("not-a-uuid", "2020-01-01", today))).toBe(true);
    expect("error" in (await getPartyStatement(ids.customer, today, "2020-01-01"))).toBe(true);
    expect((await getPartyOptions()).some((p) => p.id === ids.customer)).toBe(true);
  });
});

describe("account ledger", () => {
  it("running balance ends at the account's balance in the books", async () => {
    const acct = (await getAccountOptions()).find((a) => a.code === "1020")!;
    const { rows } = ok(await getAccountLedger(acct.id, "2000-01-01", today));
    expect(r2(rows.at(-1)!.running_balance)).toBe(await glBalance("1020"));
    expect(rows.every((r, i) => i === 0 || r.seq > rows[i - 1].seq)).toBe(true);
  });
  it("carries the earlier balance forward when the window starts later", async () => {
    const acct = (await getAccountOptions()).find((a) => a.code === "1010")!;
    const { rows } = ok(await getAccountLedger(acct.id, tomorrow, tomorrow));
    expect(rows).toHaveLength(1);
    expect(rows[0].particulars).toBe("Brought forward");
    expect(r2(rows[0].running_balance)).toBe(await glBalance("1010"));
  });
  it("shows the party on the lines that carry one", async () => {
    const acct = (await getAccountOptions()).find((a) => a.code === "1010")!;
    const { rows } = ok(await getAccountLedger(acct.id, "2019-01-01", today));
    expect(rows.some((r) => r.party_name === `Stmt Cust ${tag}`)).toBe(true);
  });
});

describe("balance sheet", () => {
  it("balances: assets = liabilities + equity + profit to date", async () => {
    const { sheet } = ok(await getBalanceSheet(today));
    expect(sheet.difference).toBe(0);
    expect(sheet.totalAssets).toBeGreaterThan(0);
    expect(r2(sheet.totalLiabilities + sheet.totalEquity + sheet.profit)).toBe(sheet.totalAssets);
  });
  it("as at a date before anything happened it is empty", async () => {
    const { sheet } = ok(await getBalanceSheet("2019-12-31"));
    expect(sheet.totalAssets).toBe(0);
    expect(sheet.difference).toBe(0);
  });
  it("as on the opening date it shows the 5,000 debtors and still balances", async () => {
    const { sheet } = ok(await getBalanceSheet("2020-01-01"));
    expect(sheet.difference).toBe(0);
    expect(sheet.assets.flatMap((g) => g.accounts).find((a) => a.code === "1010")!.amount).toBeGreaterThanOrEqual(5000);
  });
  it("a viewer can read it", async () => {
    actAs("viewer");
    expect("error" in (await getBalanceSheet(today))).toBe(false);
    actAs("admin");
  });
});

describe("stock valuation and ageing", () => {
  it("values stock at batch cost and ties to Stock in Hand in the books", async () => {
    const v = ok(await getStockValuation(today));
    const mine = v.rows.filter((r) => r.batch_id === stock.batch);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ qty: 90, unit_cost: 10, value: 900 });      // 100 bought, 10 sold, at cost 10
    expect(r2(v.rows.reduce((a, r) => a + r.value, 0) + v.inTransit)).toBe(r2(v.booksValue));   // on hand + goods in transit = Stock in Hand
  });
  it("as at a past date the later stock is not there", async () => {
    const v = ok(await getStockValuation("2019-12-31"));
    expect(v.rows.some((r) => r.batch_id === stock.batch)).toBe(false);
  });
  it("ageing buckets every batch and totals the same value", async () => {
    const a = ok(await getStockAgeing(today));
    const mine = a.rows.find((r) => r.batch_id === stock.batch)!;
    expect(mine).toMatchObject({ age_days: 0, age_bucket: "0-30", qty: 90 });
    const later = ok(await getStockAgeing(new Date(Date.now() + 100 * 86400000).toISOString().slice(0, 10))).rows.find((r) => r.batch_id === stock.batch)!;
    expect(later.age_bucket).toBe("91-180");
    const v = ok(await getStockValuation(today));
    expect(r2(a.rows.reduce((s, r) => s + r.value, 0))).toBe(r2(v.rows.filter((r) => r.qty > 0).reduce((s, r) => s + r.value, 0)));
  });
});

void tenantId;
