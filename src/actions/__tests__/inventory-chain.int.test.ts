/**
 * Master data -> memo purchase -> supplier invoice billed as another product -> stock journal -> C&F stock,
 * withdrawal and gate pass, all through the REAL server actions against the local stack. Fresh records every run.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { signInAs, actAs } from "@/test/int/session";
import { admin, tag, today, form, mustSucceed, tenantId, idByName, stockOf, glBalance } from "@/test/int/helpers";
import { addParty } from "@/actions/parties";
import { addProduct } from "@/actions/products";
import { addLocation } from "@/actions/locations";
import { createMemoPurchase, postMemoPurchase, getPendingMemoLines, getPendingBySupplier, getMatchCandidates, settleMemo, closeMemoUnits } from "@/actions/memo";
import { createPurchaseInvoice, postPurchaseInvoice } from "@/actions/purchase-invoices";
import { createStockJournal } from "@/actions/stock-journals";
import { createStockTransfer, dispatchStockTransfer, receiveStockTransfer, approveStockTransfer } from "@/actions/logistics";
import { getCfStock, recordCfConfirmation } from "@/actions/cf";
import { issueGatePass, getPendingGatePasses, getGatePasses } from "@/actions/gate-passes";

const ids = {} as Record<string, string>;

async function newProduct(name: string, code: string) {
  const r = await addProduct({}, form({
    name, product_code: code, category: "FERTILIZER", hsn_code: "3102", unit_of_measure: "BAG", gst_rate: 5, tax_status: "TAXABLE",
    mrp: 300, selling_price: 280, purchase_price: 200, batch_required: true, expiry_required: false,
  }));
  mustSucceed(r, `addProduct ${name}`);
  return idByName("products", name);
}

beforeAll(async () => {
  await signInAs("admin"); await signInAs("accountant"); await signInAs("stock"); await signInAs("sales"); await signInAs("viewer");
  actAs("admin");
  ids.tenant = await tenantId();

  mustSucceed(await addParty({}, form({ name: `Supplier ${tag}`, party_type: "SUPPLIER", is_supplier: true, gst_status: "REGULAR", state_code: "27" })), "addParty supplier");
  mustSucceed(await addParty({}, form({ name: `CF Agent ${tag}`, party_type: "CF_AGENT", is_cf_agent: true, gst_status: "UNREGISTERED", state_code: "27" })), "addParty agent");
  ids.supplier = await idByName("parties", `Supplier ${tag}`);
  ids.agent = await idByName("parties", `CF Agent ${tag}`);

  mustSucceed(await addLocation({}, form({ name: `Godown ${tag}`, code: `G${tag}`.slice(0, 20), location_type: "OWN", ownership: "OWN" })), "addLocation godown");
  mustSucceed(await addLocation({}, form({ name: `Depot ${tag}`, code: `D${tag}`.slice(0, 20), location_type: "CF_DEPOT", ownership: "CF_AGENT",
    custodian_party_id: ids.agent, stock_confirmation_freq_days: 30 })), "addLocation depot");
  ids.godown = await idByName("locations", `Godown ${tag}`);
  ids.depot = await idByName("locations", `Depot ${tag}`);

  ids.prodA = await newProduct(`Product A ${tag}`, `PA${tag}`.slice(0, 20));
  ids.prodB = await newProduct(`Product B ${tag}`, `PB${tag}`.slice(0, 20));
});

describe("memo purchase: A delivered, B billed", () => {
  const s: Record<string, string> = {};

  it("master data created through the real forms is usable", async () => {
    const { data } = await admin.from("locations").select("custodian_party_id, location_type").eq("id", ids.depot).single();
    expect(data).toMatchObject({ custodian_party_id: ids.agent, location_type: "CF_DEPOT" });
  });

  it("creates and posts a memo: 100 x A @ 10, 2% discount, no GST", async () => {
    const r = await createMemoPurchase({
      supplier_id: ids.supplier, received_at_location: ids.godown, memo_date: today, supplier_ref: `CH-${tag}`,
      lines: [{ product_id: ids.prodA, qty: 100, free_qty: 0, rate: 10, discount_percent: 2, discount_amount: 0, batch_number: `MA-${tag}` }],
    });
    mustSucceed(r, "createMemoPurchase");
    const memo = await admin.from("memo_purchases").select("id, status").eq("memo_no", r.memoNo!).single();
    s.memo = memo.data!.id;
    expect(memo.data!.status).toBe("DRAFT");
    mustSucceed(await postMemoPurchase(s.memo), "postMemoPurchase");

    const line = await admin.from("memo_purchase_lines").select("id, net_amount, unit_cost, batch_id").eq("memo_id", s.memo).single();
    s.memoLine = line.data!.id; s.memoBatch = line.data!.batch_id;
    expect(Number(line.data!.net_amount)).toBe(980);
    expect(Number(line.data!.unit_cost)).toBe(9.8);
    expect(await stockOf({ batchId: s.memoBatch })).toBe(100);
  });

  it("a memo without the supplier's reference is refused", async () => {
    const r = await createMemoPurchase({
      supplier_id: ids.supplier, received_at_location: ids.godown, memo_date: today, supplier_ref: "  ",
      lines: [{ product_id: ids.prodA, qty: 1, free_qty: 0, rate: 10, discount_percent: 0, discount_amount: 0 }],
    });
    expect(r.success).toBe(false);
  });

  it("shows the supplier in the pending-invoice list", async () => {
    const lines = await getPendingMemoLines();
    expect(lines.find((l) => l.memo_line_id === s.memoLine)).toMatchObject({ pending_units: 100, pending_value: 980 });
    const sup = (await getPendingBySupplier()).find((x) => x.supplier_id === ids.supplier);
    expect(Number(sup!.pending_value)).toBe(980);
  });

  it("the supplier's invoice arrives billed as B; matching it offers the B-out / A-in stock journal", async () => {
    const r = await createPurchaseInvoice({}, form({
      supplier_id: ids.supplier, supplier_type: "REGISTERED", invoice_date: today, supplier_invoice_no: `INV-${tag}`,
      received_at_location: ids.godown, is_interstate: false,
    }, [{ product_id: ids.prodB, hsn_code: "3102", batch_number: `MB-${tag}`, received_qty: 100, free_qty: 0, unit_of_measure: "BAG", unit_price: 10, gst_rate: 5 }]));
    mustSucceed(r, "createPurchaseInvoice");
    mustSucceed(await postPurchaseInvoice(r.invoiceId!), "postPurchaseInvoice");
    s.invoice = r.invoiceId!;

    const candidates = await getMatchCandidates(ids.supplier);
    const inv = candidates.find((c) => c.id === s.invoice)!;
    expect(inv.lines[0]).toMatchObject({ unmatched_units: 100, product_id: ids.prodB });

    const res = await settleMemo({ memoId: s.memo, invoiceId: s.invoice, lines: [{ memoLineId: s.memoLine, invoiceLineId: inv.lines[0].id, units: 100 }] });
    if (!res.success) throw new Error(`settleMemo failed: ${res.error}`);
    expect(res.suggestions).toHaveLength(1);
    expect(res.suggestions[0]).toMatchObject({ inProductId: ids.prodA, qty: 100, locationId: ids.godown });
    s.settlement = res.settlementId;

    // memo stock is taken back out, B stock is in
    expect(await stockOf({ batchId: s.memoBatch })).toBe(0);
    expect(await stockOf({ productId: ids.prodB })).toBe(100);
    expect((await getPendingMemoLines()).find((l) => l.memo_line_id === s.memoLine)).toBeUndefined();

    // post the suggested journal
    const sg = res.suggestions[0];
    const j = await createStockJournal({
      date: today, locationId: sg.locationId, reason: `Billed as B against physical A (${tag})`,
      out: [{ batchId: sg.outBatchId, qty: sg.qty }], in: [{ productId: sg.inProductId, qty: sg.qty }],
      memoSettlementId: s.settlement, purchaseInvoiceId: s.invoice,
    });
    mustSucceed(j, "createStockJournal");
    expect(await stockOf({ productId: ids.prodB })).toBe(0);
    expect(await stockOf({ productId: ids.prodA })).toBe(100);
    const nb = await admin.from("batch_register").select("landing_cost_per_unit").eq("product_id", ids.prodA).neq("id", s.memoBatch).single();
    expect(Number(nb.data!.landing_cost_per_unit)).toBe(10);          // carries the invoiced value, not the memo's 9.80
  });

  it("goods that will never be billed can be returned or waived", async () => {
    const r = await createMemoPurchase({
      supplier_id: ids.supplier, received_at_location: ids.godown, memo_date: today, supplier_ref: `CH2-${tag}`,
      lines: [{ product_id: ids.prodA, qty: 10, free_qty: 0, rate: 10, discount_percent: 0, discount_amount: 0 }],
    });
    mustSucceed(r, "createMemoPurchase #2");
    const m = await admin.from("memo_purchases").select("id").eq("memo_no", r.memoNo!).single();
    mustSucceed(await postMemoPurchase(m.data!.id), "post #2");
    const line = await admin.from("memo_purchase_lines").select("id").eq("memo_id", m.data!.id).single();
    const before = await stockOf({ productId: ids.prodA });
    mustSucceed(await closeMemoUnits({ memoLineId: line.data!.id, units: 10, mode: "RETURN", reason: "Sent back, not ordered" }), "closeMemoUnits");
    expect(await stockOf({ productId: ids.prodA })).toBe(before - 10);
  });

  it("the pending liability on the books equals the pending-invoice report", async () => {
    const pending = (await getPendingMemoLines()).reduce((s2, l) => s2 + Number(l.pending_value), 0);
    expect(-(await glBalance("2005"))).toBeCloseTo(pending, 1);
  });
});

describe("C&F stock, withdrawal and gate pass", () => {
  const s: Record<string, string> = {};

  it("sends stock to the C&F depot and receives it with a damaged bag", async () => {
    const batch = await admin.from("batch_register").select("id").eq("product_id", ids.prodA).gt("current_qty", 0).limit(1).single();
    s.batch = batch.data!.id;
    const r = await createStockTransfer({
      transfer_no: `TR-${tag}`, transfer_date: today, transfer_type: "INTER_BRANCH",
      source_location_id: ids.godown, destination_location_id: ids.depot, cf_agent_id: ids.agent,
      items: [{ product_id: ids.prodA, source_batch_id: s.batch, unit_of_measure: "BAG", requested_qty: 20, unit_cost: 0 }],
    } as Parameters<typeof createStockTransfer>[0]);
    mustSucceed(r, "createStockTransfer");
    s.tr = (r.data as { id: string }).id;
    mustSucceed(await dispatchStockTransfer(s.tr), "dispatchStockTransfer");
    const item = await admin.from("stock_transfer_items").select("id").eq("transfer_id", s.tr).single();
    mustSucceed(await receiveStockTransfer(s.tr, [{ itemId: item.data!.id, received: 19, damaged: 1 }], "one bag burst"), "receiveStockTransfer");
    expect(await stockOf({ locationId: ids.depot, productId: ids.prodA })).toBe(19);
    expect(await glBalance("4050")).toBeGreaterThan(0);        // transit loss written off at cost
  });

  it("the C&F register shows it (derived from the ledger) and the agent's count can be recorded", async () => {
    const row = (await getCfStock()).find((x) => x.location_id === ids.depot && x.product_id === ids.prodA)!;
    expect(row).toMatchObject({ system_qty: 19, confirmation_status: "NEVER_CONFIRMED", cf_agent_name: `CF Agent ${tag}` });
    const bad = await recordCfConfirmation({ locationId: ids.depot, productId: ids.prodA, batchId: row.batch_id, confirmedQty: 18 });
    expect(bad.success).toBe(false);                            // a difference needs a remark
    const ok = await recordCfConfirmation({ locationId: ids.depot, productId: ids.prodA, batchId: row.batch_id, confirmedQty: 18, remarks: "1 bag water damaged" });
    mustSucceed(ok, "recordCfConfirmation");
    const after = (await getCfStock()).find((x) => x.location_id === ids.depot && x.product_id === ids.prodA)!;
    expect(after.confirmation_status).toBe("DISCREPANCY");
  });

  it("a C&F withdrawal needs the company's approval reference before it can be dispatched", async () => {
    const row = (await getCfStock()).find((x) => x.location_id === ids.depot && x.product_id === ids.prodA)!;
    const r = await createStockTransfer({
      transfer_no: `WD-${tag}`, transfer_date: today, transfer_type: "CNF_TO_OWN_WAREHOUSE",
      source_location_id: ids.depot, destination_location_id: ids.godown, cf_agent_id: ids.agent, cnf_withdrawal_req_no: `REQ-${tag}`,
      items: [{ product_id: ids.prodA, source_batch_id: row.batch_id!, unit_of_measure: "BAG", requested_qty: 5, unit_cost: 0 }],
    } as Parameters<typeof createStockTransfer>[0]);
    mustSucceed(r, "create withdrawal");
    const id = (r.data as { id: string }).id;
    expect((await dispatchStockTransfer(id)).success).toBe(false);          // not approved yet
    expect((await approveStockTransfer(id, "")).success).toBe(false);       // approval needs the reference
    mustSucceed(await approveStockTransfer(id, `APR-${tag}`), "approveStockTransfer");
    mustSucceed(await dispatchStockTransfer(id), "dispatch withdrawal");
    mustSucceed(await receiveStockTransfer(id), "receive withdrawal");
    expect(await stockOf({ locationId: ids.depot, productId: ids.prodA })).toBe(14);
  });

  it("issues a gate pass against the dispatched transfer, once", async () => {
    expect((await getPendingGatePasses()).some((p) => p.reference_doc_id === s.tr && p.pass_type === "OUTWARD_TRANSFER")).toBe(true);
    const r = await issueGatePass({ referenceType: "STOCK_TRANSFER", referenceId: s.tr, passType: "OUTWARD_TRANSFER", vehicleNo: "mh 12 ab 1234",
      driverName: "Raju", driverMobile: "+91 98765 43210", totalPackages: 20, securityOfficer: "Guard Singh" });
    mustSucceed(r, "issueGatePass");
    expect((await getGatePasses()).find((g) => g.reference_doc_id === s.tr && g.pass_type === "OUTWARD_TRANSFER")).toMatchObject({ vehicle_no: "MH12AB1234", driver_mobile: "9876543210" });
    expect((await issueGatePass({ referenceType: "STOCK_TRANSFER", referenceId: s.tr, passType: "OUTWARD_TRANSFER", vehicleNo: "MH12AB1234" })).success).toBe(false);
  });

  it("roles: a stock manager runs transfers but cannot approve a sale; a sales manager cannot approve transfers", async () => {
    const row = (await getCfStock()).find((x) => x.location_id === ids.depot && x.product_id === ids.prodA)!;
    actAs("admin");
    const r = await createStockTransfer({
      transfer_no: `RB-${tag}`, transfer_date: today, transfer_type: "INTER_BRANCH", source_location_id: ids.depot, destination_location_id: ids.godown,
      items: [{ product_id: ids.prodA, source_batch_id: row.batch_id!, unit_of_measure: "BAG", requested_qty: 1, unit_cost: 0 }],
    } as Parameters<typeof createStockTransfer>[0]);
    mustSucceed(r, "create role-test transfer");
    const id = (r.data as { id: string }).id;
    actAs("sales");
    expect((await approveStockTransfer(id, "x")).error ?? "").toMatch(/permission/i);
    expect((await dispatchStockTransfer(id)).error ?? "").toMatch(/permission/i);
    actAs("viewer");
    expect((await dispatchStockTransfer(id)).error ?? "").toMatch(/permission/i);
    actAs("stock");
    mustSucceed(await dispatchStockTransfer(id), "stock manager dispatch");
    actAs("admin");
  });
});
