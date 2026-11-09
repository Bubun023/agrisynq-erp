/**
 * FMS chain through the REAL server actions: farmer sale -> post -> ledger -> reconciliation -> portal import ->
 * cancel & reissue -> subsidy claim -> receipts. Fresh dealer id / PoS ids each run; stock comes from a purchase made here.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { signInAs, actAs } from "@/test/int/session";
import { admin, tag, today, form, mustSucceed, tenantId, idByName, stockOf, glBalance } from "@/test/int/helpers";
import { addLocation } from "@/actions/locations";
import { addProduct } from "@/actions/products";
import { createPurchaseInvoice, postPurchaseInvoice } from "@/actions/purchase-invoices";
import { createFarmerSale, postFarmerSale } from "@/actions/farmer-sales";
import {
  getFmsLedger, runFmsReconciliation, resolveFmsReconciliation, importFmsData, getFmsImportDetail,
  reissueFarmerSale, cancelFarmerSale, getCancellableFarmerSales,
} from "@/actions/fms";
import {
  createSubsidyClaim, submitSubsidyClaim, recordSubsidyReceipt, getSubsidyClaims, getSubsidyClaimDetail, getSubsidyOverview, getBankAccountOptions,
} from "@/actions/subsidy";

const monthStart = today.slice(0, 8) + "01";
const dealer = `DLR-${tag}`;
const ids = {} as Record<string, string>;
const pos = (n: number) => `POS-${tag}-${n}`;

async function sale(n: number, qty: number, opts: { subsidy?: number; withPos?: boolean } = {}) {
  const subsidyPerUnit = opts.subsidy ?? 15;
  const payable = qty * (20 - subsidyPerUnit);
  const net = Math.round(payable * 1.05 * 100) / 100;
  return createFarmerSale({}, form({
    farmer_id: ids.farmer, product_id: ids.product, hsn_code: "3102", batch_id: ids.batch, batch_number: `FB-${tag}`, sale_at_location: ids.godown,
    sale_date: today, qty_sold: qty, unit_of_measure: "BAG", selling_price_per_unit: 20, subsidy_per_unit: subsidyPerUnit, gst_rate: 5,
    subsidy_type: subsidyPerUnit > 0 ? "NEEM_COATED_UREA" : "NONE", fms_dealer_id: dealer, fms_product_code: "UREA45",
    pos_transaction_id: opts.withPos === false ? "" : pos(n), cash_received: net,
  }));
}
async function saleId(n: number) {
  return (await admin.from("farmer_sales").select("id").eq("pos_transaction_id", pos(n)).single()).data!.id as string;
}

beforeAll(async () => {
  for (const u of ["admin", "sales", "fms", "viewer", "accountant"] as const) await signInAs(u);
  actAs("admin");
  mustSucceed(await addLocation({}, form({ name: `FMS Shop ${tag}`, code: `F${tag}`.slice(0, 20), location_type: "OWN", ownership: "OWN" })), "addLocation");
  ids.godown = await idByName("locations", `FMS Shop ${tag}`);
  mustSucceed(await addProduct({}, form({ name: `Neem Urea ${tag}`, product_code: `NU${tag}`.slice(0, 20), category: "FERTILIZER", hsn_code: "3102",
    unit_of_measure: "BAG", gst_rate: 5, tax_status: "TAXABLE", mrp: 266, selling_price: 20, purchase_price: 10, batch_required: true })), "addProduct");
  ids.product = await idByName("products", `Neem Urea ${tag}`);
  ids.supplier = await idByName("parties", "Kisan Fertilisers Ltd");
  ids.farmer = ((await admin.from("farmers").select("id").eq("first_name", "Ramesh").eq("tenant_id", await tenantId()).single()).data!).id;

  const pi = await createPurchaseInvoice({}, form({ supplier_id: ids.supplier, supplier_type: "REGISTERED", invoice_date: today, supplier_invoice_no: `FM-${tag}`,
    received_at_location: ids.godown, is_interstate: false },
    [{ product_id: ids.product, hsn_code: "3102", batch_number: `FB-${tag}`, received_qty: 200, free_qty: 0, unit_of_measure: "BAG", unit_price: 10, gst_rate: 5 }]));
  mustSucceed(pi, "createPurchaseInvoice");
  mustSucceed(await postPurchaseInvoice(pi.invoiceId!), "postPurchaseInvoice");
  ids.batch = (await admin.from("batch_register").select("id").eq("batch_number", `FB-${tag}`).single()).data!.id;
});

describe("farmer sale -> ledger -> reconciliation -> import", () => {
  it("records and posts a subsidised sale: stock out, subsidy receivable up", async () => {
    const receivableBefore = await glBalance("1040");
    mustSucceed(await sale(1, 10), "createFarmerSale");
    const id = await saleId(1);
    mustSucceed(await postFarmerSale(id), "postFarmerSale");
    expect(await stockOf({ batchId: ids.batch })).toBe(190);
    expect(Math.round(((await glBalance("1040")) - receivableBefore) * 100) / 100).toBe(150);
    const row = (await getFmsLedger({ search: pos(1) }))[0];
    expect(row).toMatchObject({ compliance_flag: "OK", status: "POSTED", total_subsidy_amount: 150 });
  });

  it("a PoS id cannot be recorded twice, and a subsidised sale without one cannot be posted", async () => {
    const dup = await sale(1, 1);
    expect(dup.error ?? "").toMatch(/already been recorded/i);
    mustSucceed(await sale(2, 2, { withPos: false }), "createFarmerSale without PoS");
    const unposted = (await admin.from("farmer_sales").select("id").eq("fms_dealer_id", dealer).is("pos_transaction_id", null).single()).data!.id;
    const r = await postFarmerSale(unposted);
    expect(r.error ?? "").toMatch(/PoS transaction ID/);
    const flag = (await getFmsLedger({ flag: "MISSING_POS" })).some((x) => x.id === unposted);
    expect(flag).toBe(true);
  });

  it("reconciles portal totals with the system, flags and resolves a variance", async () => {
    const ok = await runFmsReconciliation({ period_from: monthStart, period_to: today, dealer_id: dealer, product_code: "UREA45", fms_qty: 10, fms_txns: 1, fms_subsidy: 150 });
    mustSucceed(ok, "runFmsReconciliation");
    expect(ok.data!.reconciliation_status).toBe("MATCHED");
    const bad = await runFmsReconciliation({ period_from: monthStart, period_to: today, dealer_id: dealer, product_code: "UREA45", fms_qty: 12, fms_txns: 1, fms_subsidy: 150 });
    expect(bad.data!.reconciliation_status).toBe("VARIANCE");
    expect((await resolveFmsReconciliation(bad.data!.id, "  ")).success).toBe(false);
    mustSucceed(await resolveFmsReconciliation(bad.data!.id, "Portal double-counted a reversed bill"), "resolve");
  });

  it("imports the portal file and matches it by PoS id", async () => {
    const r = await importFmsData({ filename: "portal.csv", dealerId: dealer, periodFrom: monthStart, periodTo: today,
      lines: [{ pos_id: pos(1), qty: 10, subsidy: 150, ack: "ACK-1" }, { pos_id: `UNKNOWN-${tag}`, qty: 1, subsidy: 15 }] });
    mustSucceed(r, "importFmsData");
    expect(r.batch).toMatchObject({ total_lines: 2, matched: 1, missing_in_system: 1 });
    const d = await getFmsImportDetail(r.batch!.id);
    expect(d.lines.find((l) => l.pos_transaction_id === pos(1))?.match_status).toBe("MATCHED");
  });
});

describe("cancel & reissue", () => {
  it("cancels a posted sale (stock and books reversed) and reissues it under a new PoS id", async () => {
    mustSucceed(await sale(3, 5), "createFarmerSale #3");
    const id = await saleId(3);
    mustSucceed(await postFarmerSale(id), "post #3");
    const stockAfterSale = await stockOf({ batchId: ids.batch });
    const receivable = await glBalance("1040");

    const same = await reissueFarmerSale({ saleId: id, reason: "wrong qty keyed", newPosId: pos(3), qty: 4 });
    expect(same.success).toBe(false);                                    // the old PoS id can never be reused
    const r = await reissueFarmerSale({ saleId: id, reason: "wrong qty keyed at the PoS", newPosId: pos(4), qty: 4 });
    mustSucceed(r, "reissueFarmerSale");
    expect(await stockOf({ batchId: ids.batch })).toBe(stockAfterSale + 5);               // fully restored
    expect(Math.round(((await glBalance("1040")) - receivable) * 100) / 100).toBe(-75);  // 5 x 15 reversed

    mustSucceed(await postFarmerSale(await saleId(4)), "post the replacement");
    expect(await stockOf({ batchId: ids.batch })).toBe(stockAfterSale + 5 - 4);
    expect((await getCancellableFarmerSales()).some((x) => x.id === id)).toBe(false);
  });

  it("an FMS officer may cancel/reissue; a sales manager may not", async () => {
    mustSucceed(await sale(5, 1), "createFarmerSale #5");
    const id = await saleId(5);
    mustSucceed(await postFarmerSale(id), "post #5");
    actAs("sales");
    expect((await cancelFarmerSale(id, "test")).error ?? "").toMatch(/permission/i);
    actAs("fms");
    mustSucceed(await cancelFarmerSale(id, "customer returned the bag"), "cancelFarmerSale as FMS officer");
    actAs("admin");
  });
});

describe("subsidy claim lifecycle", () => {
  it("claims the unclaimed sales, receives the money in two parts, and clears the receivable", async () => {
    const claim = await createSubsidyClaim({ periodFrom: monthStart, periodTo: today, subsidyType: "NEEM_COATED_UREA" });
    mustSucceed(claim, "createSubsidyClaim");
    const total = Number(claim.claim!.total_subsidy_claimed);
    expect(total).toBeGreaterThanOrEqual(150 + 60);            // at least this run's sales #1 (150) and #4 (4 x 15)
    const detail = await getSubsidyClaimDetail(claim.claim!.id);
    expect(detail.sales.some((x) => x.pos_transaction_id === pos(1))).toBe(true);

    mustSucceed(await submitSubsidyClaim(claim.claim!.id, today, `GOV/${tag}`), "submit");
    const banks = await getBankAccountOptions();
    expect(banks.length).toBeGreaterThan(0);
    const before = await glBalance("1040");
    mustSucceed(await recordSubsidyReceipt({ claimId: claim.claim!.id, amount: 100, date: today, accountId: banks[0].id, reference: `UTR-${tag}-1` }), "receipt 1");
    expect(Math.round((before - (await glBalance("1040"))) * 100) / 100).toBe(100);
    const rest = Math.round((total - 100) * 100) / 100;
    expect((await recordSubsidyReceipt({ claimId: claim.claim!.id, amount: rest + 1, date: today })).success).toBe(false);   // more than pending
    mustSucceed(await recordSubsidyReceipt({ claimId: claim.claim!.id, amount: rest, date: today }), "receipt 2");
    expect((await getSubsidyClaims()).find((c) => c.id === claim.claim!.id)).toMatchObject({ claim_status: "FULLY_RECEIVED", subsidy_pending: 0 });
  });

  it("the Subsidy Receivable on the books equals what the claims screen says is outstanding", async () => {
    const o = await getSubsidyOverview();
    expect(Math.round((await glBalance("1040")) * 100) / 100).toBeCloseTo(o.unclaimedAmount + o.awaitingReceipt, 1);
  });
});
