/**
 * Breadth: orders & quotations, delivery challans (+transporter, gate pass), journal vouchers, bank statements,
 * stock adjustments, period locks, settings and invitations - each through the REAL server actions.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signInAs, actAs } from "@/test/int/session";
import { admin, tag, today, form, mustSucceed, tenantId, idByName, stockOf, seedStock, glBalance } from "@/test/int/helpers";
import { createPurchaseOrder, updatePOStatus } from "@/actions/purchase-orders";
import { createQuotation, createSalesOrder } from "@/actions/sales-orders";
import { createTransporter, createDeliveryChallan, getDeliveryChallans } from "@/actions/logistics";
import { issueGatePass } from "@/actions/gate-passes";
import { createJournalVoucher, postJournalVoucher, createPaymentReceipt, postPaymentReceipt, getTrialBalance } from "@/actions/accounting";
import { createBankAccount, importBankStatementLines, matchStatementLine, unmatchStatementLine, excludeStatementLine, getBankStatements } from "@/actions/bank";
import { createStockAdjustment, getStockAdjustments } from "@/actions/inventory";
import { lockPeriod, unlockPeriod, getPeriodLocks, saveOrgSettings, getOrgSettings, createInvitation, getInvitations } from "@/actions/admin";
import { createPurchaseInvoice, postPurchaseInvoice } from "@/actions/purchase-invoices";
import { addParty } from "@/actions/parties";

const ids = {} as Record<string, string>;
let stock: Awaited<ReturnType<typeof seedStock>>;

beforeAll(async () => {
  for (const u of ["admin", "accountant", "viewer", "stock"] as const) await signInAs(u);
  actAs("admin");
  ids.tenant = await tenantId();
  ids.supplier = await idByName("parties", "Kisan Fertilisers Ltd");
  ids.customer = await idByName("parties", "Green Valley Retail");
  stock = await seedStock("BR", 100, 10);
});

describe("orders and quotations", () => {
  it("creates a purchase order and moves it through its statuses", async () => {
    const r = await createPurchaseOrder({}, form({ supplier_id: ids.supplier, po_date: today, deliver_to_location: stock.location, payment_terms_days: 30 },
      [{ product_id: stock.product, hsn_code: "3102", ordered_qty: 50, unit_of_measure: "BAG", unit_price: 10, gst_rate: 5 }]));
    mustSucceed(r, "createPurchaseOrder");
    const po = await admin.from("purchase_orders").select("id, status").eq("tenant_id", ids.tenant).order("created_at", { ascending: false }).limit(1).single();
    mustSucceed(await updatePOStatus(po.data!.id, "SENT"), "updatePOStatus SENT");
    expect((await admin.from("purchase_orders").select("status").eq("id", po.data!.id).single()).data!.status).toBe("SENT");
  });

  it("creates a quotation and a sales order", async () => {
    mustSucceed(await createQuotation({}, form({ customer_id: ids.customer, quotation_date: today },
      [{ product_id: stock.product, hsn_code: "3102", ordered_qty: 10, unit_of_measure: "BAG", unit_price: 25, gst_rate: 5 }])), "createQuotation");
    mustSucceed(await createSalesOrder({}, form({ customer_id: ids.customer, order_date: today, from_location: stock.location, is_credit_sale: true, payment_terms_days: 15 },
      [{ product_id: stock.product, hsn_code: "3102", ordered_qty: 10, unit_of_measure: "BAG", unit_price: 25, gst_rate: 5 }])), "createSalesOrder");
  });
});

describe("delivery challan with a transporter, then a gate pass", () => {
  it("saves a challan (real table columns), lists it back, and carries a gate pass", async () => {
    mustSucceed(await createTransporter({ transporter_code: `TR${tag}`.slice(0, 30), legal_name: `Fast Movers ${tag}`, mobile: "9876543210" } as Parameters<typeof createTransporter>[0]), "createTransporter");
    const tr = await idByName("transporters", `Fast Movers ${tag}`).catch(async () =>
      (await admin.from("transporters").select("id").eq("legal_name", `Fast Movers ${tag}`).single()).data!.id as string);

    const r = await createDeliveryChallan({
      challan_no: `DC-${tag}`, challan_date: today, purpose: "DELIVERY_AGAINST_INVOICE", dispatch_location_id: stock.location,
      consignee_name: "Green Valley Retail", consignee_gstin: "27AAACG2222B1Z2", delivery_address: "Plot 5, MIDC, Pune", place_of_supply_state: "Maharashtra",
      transporter_id: tr, vehicle_no: "mh12ab1234", driver_name: "Raju", driver_mobile: "9876543210", distance_km: 25,
      items: [{ product_id: stock.product, batch_id: stock.batch, unit_of_measure: "BAG", qty: 5, declared_unit_rate: 10 }],
    } as Parameters<typeof createDeliveryChallan>[0]);
    mustSucceed(r, "createDeliveryChallan");

    const listed = (await getDeliveryChallans()).find((c) => c.challan_no === `DC-${tag}`)!;
    expect(listed).toMatchObject({ vehicle_no: "MH12AB1234", consignee_name: "Green Valley Retail", place_of_supply_state: "Maharashtra", status: "DISPATCHED" });
    expect(listed.items).toHaveLength(1);

    mustSucceed(await issueGatePass({ referenceType: "DELIVERY_CHALLAN", referenceId: listed.id, passType: "OUTWARD_SALE", vehicleNo: "MH12AB1234" }), "issueGatePass");
  });
});

describe("journal vouchers and the trial balance", () => {
  it("creates, balances and posts a manual journal", async () => {
    const acct = async (code: string) => (await admin.from("chart_of_accounts").select("id").eq("tenant_id", ids.tenant).eq("account_code", code).single()).data!.id as string;
    const cash = await acct("1001"), capital = await acct("2100");
    const bad = await createJournalVoucher({ voucher_no: `JV-BAD-${tag}`, voucher_date: today, voucher_type: "JOURNAL", narration: "unbalanced",
      lines: [{ account_id: cash, debit_amount: 1000, credit_amount: 0 }, { account_id: capital, debit_amount: 0, credit_amount: 900 }] } as Parameters<typeof createJournalVoucher>[0]);
    expect(bad.success).toBe(false);

    const r = await createJournalVoucher({ voucher_no: `JV-${tag}`, voucher_date: today, voucher_type: "JOURNAL", narration: "Capital introduced",
      lines: [{ account_id: cash, debit_amount: 5000, credit_amount: 0 }, { account_id: capital, debit_amount: 0, credit_amount: 5000 }] } as Parameters<typeof createJournalVoucher>[0]);
    mustSucceed(r, "createJournalVoucher");
    const jv = (await admin.from("journal_vouchers").select("id, status").eq("voucher_no", `JV-${tag}`).single()).data!;
    expect(jv.status).toBe("DRAFT");
    mustSucceed(await postJournalVoucher(jv.id), "postJournalVoucher");
    expect((await admin.from("journal_vouchers").select("status").eq("id", jv.id).single()).data!.status).toBe("POSTED");
    const tb = await getTrialBalance();
    expect(Array.isArray(tb) ? tb.length : 0).toBeGreaterThan(0);
  });
});

describe("bank statement import and matching", () => {
  it("imports statement lines and matches one to a receipt", async () => {
    const acc = await createBankAccount({ account_name: `Current ${tag}`, account_no: `AC${tag}`, bank_name: "State Bank", account_type: "CURRENT", opening_balance: 10000, opening_date: today });
    if (acc.error) throw new Error(`createBankAccount failed: ${acc.error}`);
    const bankId = (acc.data as { id: string }).id;

    const imp = await importBankStatementLines({ bank_account_id: bankId, lines: [
      { value_date: today, description: `UPI from customer ${tag}`, ref_no: `UTR${tag}`, txn_type: "CREDIT", amount: 2500, balance: 12500 },
      { value_date: today, description: "Bank charges", txn_type: "DEBIT", amount: 118, balance: 12382 },
      { value_date: today, description: "Cheque not ours", txn_type: "DEBIT", amount: 50, balance: 12332 },
    ] });
    if (imp.error) throw new Error(`importBankStatementLines failed: ${imp.error}`);
    const lines = await getBankStatements({ bankAccountId: bankId });
    expect(lines).toHaveLength(3);

    // a receipt posted in the books for the same UTR
    const cust = await (async () => {
      mustSucceed(await addParty({}, form({ name: `Bank Cust ${tag}`, party_type: "CUSTOMER", is_customer: true, gst_status: "UNREGISTERED" })), "addParty");
      return idByName("parties", `Bank Cust ${tag}`);
    })();
    const rc = await createPaymentReceipt({ receipt_no: `BR-${tag}`, receipt_date: today, receipt_type: "RECEIPT", party_id: cust, payment_mode: "UPI", amount: 2500, utr_no: `UTR${tag}`, bank_account_id: "" } as Parameters<typeof createPaymentReceipt>[0]);
    mustSucceed(rc, "createPaymentReceipt");
    const rid = (rc.data as { id: string }).id;
    mustSucceed(await postPaymentReceipt(rid), "postPaymentReceipt");

    const credit = lines.find((l) => l.txn_type === "CREDIT")!;
    const m = await matchStatementLine({ line_id: credit.id, matched_receipt_id: rid });
    if (m.error) throw new Error(`matchStatementLine failed: ${m.error}`);
    expect((await getBankStatements({ bankAccountId: bankId })).find((l) => l.id === credit.id)!.recon_status).toBe("MATCHED");
    expect((await unmatchStatementLine(credit.id)).error).toBeUndefined();
    const ex = await excludeStatementLine(lines.find((l) => l.description === "Cheque not ours")!.id, "not ours");
    expect(ex.error).toBeUndefined();
  });
});

describe("stock adjustment", () => {
  it("moves stock and refuses to make it negative", async () => {
    const before = await stockOf({ batchId: stock.batch });
    const bookStock = await glBalance("1020"), bookLoss = await glBalance("4050");
    const ok = await createStockAdjustment({ adjustment_date: today, product_id: stock.product, batch_id: stock.batch, location_id: stock.location, reason: "DAMAGE", qty_adjustment: -3, notes: "rats" });
    if (ok.error) throw new Error(`createStockAdjustment failed: ${ok.error}`);
    expect(await stockOf({ batchId: stock.batch })).toBe(before - 3);
    // the books follow the stock: 3 bags lost at cost 10 -> Stock in Hand down 30, Stock Shortage up 30
    expect(Math.round((bookStock - await glBalance("1020")) * 100) / 100).toBe(30);
    expect(Math.round((await glBalance("4050") - bookLoss) * 100) / 100).toBe(30);
    const bad = await createStockAdjustment({ adjustment_date: today, product_id: stock.product, batch_id: stock.batch, location_id: stock.location, reason: "RECOUNT", qty_adjustment: -100000 });
    expect(bad.error ?? "").toMatch(/negative/i);
    expect((await getStockAdjustments()).some((a) => a.product_id === stock.product)).toBe(true);
  });
});

describe("administration", () => {
  afterAll(async () => {
    // never leave the demo period locked for the other test files
    actAs("admin");
    const locks = await getPeriodLocks();
    for (const l of locks.filter((x) => x.is_locked)) await unlockPeriod(l.id, "test cleanup");
  });

  it("a locked period blocks posting; unlocking needs a reason and restores it", async () => {
    const d = new Date();
    mustSucceed({ success: !(await lockPeriod(d.getFullYear(), d.getMonth() + 1)).error }, "lockPeriod");
    const pi = await createPurchaseInvoice({}, form({ supplier_id: ids.supplier, supplier_type: "REGISTERED", invoice_date: today, supplier_invoice_no: `LK-${tag}`,
      received_at_location: stock.location, is_interstate: false },
      [{ product_id: stock.product, hsn_code: "3102", batch_number: `LK-${tag}`, received_qty: 1, free_qty: 0, unit_of_measure: "BAG", unit_price: 10, gst_rate: 5 }]));
    // either the draft itself or its posting is refused for a locked month
    const blocked = !pi.success || !(await postPurchaseInvoice(pi.invoiceId!)).success;
    expect(blocked).toBe(true);

    const lock = (await getPeriodLocks()).find((l) => l.is_locked && l.period_year === d.getFullYear() && l.period_month === d.getMonth() + 1)!;
    expect((await unlockPeriod(lock.id, "  ")).error ?? "").toMatch(/reason/i);
    expect((await unlockPeriod(lock.id, "month re-opened for correction")).error).toBeUndefined();
  });

  it("only admins change settings, locks and invitations", async () => {
    mustSucceed({ success: !(await saveOrgSettings({ invoice_prefix: `T${tag}`.slice(0, 8) })).error }, "saveOrgSettings");
    expect((await getOrgSettings()).invoice_prefix).toBe(`T${tag}`.slice(0, 8));

    actAs("viewer");
    expect((await saveOrgSettings({ invoice_prefix: "HACK" })).error ?? "").toBeTruthy();
    expect((await lockPeriod(2020, 1)).error ?? "").toBeTruthy();
    expect((await createInvitation(`nobody${tag}@x.test`, "VIEWER")).error ?? "").toBeTruthy();
    actAs("accountant");
    expect((await lockPeriod(2020, 1)).error ?? "").toBeTruthy();                 // period locks are admin-only
    actAs("admin");
    const inv = await createInvitation(`new${tag}@fertiledger.test`.toLowerCase(), "VIEWER");
    expect(inv.error).toBeUndefined();
    expect((await getInvitations()).some((i) => i.email === `new${tag}@fertiledger.test`.toLowerCase())).toBe(true);
  });
});
