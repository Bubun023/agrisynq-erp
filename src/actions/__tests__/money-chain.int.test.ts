/**
 * The core money chain, driven through the REAL server actions (the code behind the buttons) against the local stack:
 * purchase invoice -> post -> sales invoice -> post -> receipt -> post -> credit note -> post.
 * Checks stock, invoice balances and the books after every step. Numbers are unique per run so it can be re-run.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { adminClient, signInAs, actAs } from "@/test/int/session";
import { createPurchaseInvoice, postPurchaseInvoice } from "@/actions/purchase-invoices";
import { createSalesInvoice, postSalesInvoice } from "@/actions/sales-invoices";
import { createPaymentReceipt, postPaymentReceipt } from "@/actions/accounting";
import { createCreditNote, postCreditNote } from "@/actions/credit-notes";
import { addParty } from "@/actions/parties";

const admin = adminClient();
const tag = Date.now().toString(36).toUpperCase();
const today = new Date().toISOString().slice(0, 10);
const ids = {} as Record<string, string>;

function form(fields: Record<string, string | number | boolean>, lines: unknown[]) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, String(v));
  fd.set("lines", JSON.stringify(lines));
  return fd;
}
/** Fails with the action's own message (and field errors) instead of an opaque "expected true". */
function mustSucceed(r: { success?: boolean; error?: string; fieldErrors?: Record<string, string[]> }, what: string) {
  if (!r.success) throw new Error(`${what} failed: ${r.error ?? JSON.stringify(r.fieldErrors)}`);
}
async function stockOf(batchId: string) {
  const { data } = await admin.from("stock_balance").select("balance_qty").eq("batch_id", batchId);
  return (data ?? []).reduce((s, r) => s + Number(r.balance_qty), 0);
}
async function glBalance(code: string) {
  const { data } = await admin.from("vw_trial_balance").select("period_debit, period_credit").eq("account_code", code)
    .eq("tenant_id", ids.tenant);
  return (data ?? []).reduce((s, r) => s + Number(r.period_debit) - Number(r.period_credit), 0);
}

beforeAll(async () => {
  await signInAs("admin");
  const t = await admin.from("tenants").select("id").eq("slug", "demo").single();
  ids.tenant = t.data!.id;
  const q = async (table: string, col: string, val: string) => (await admin.from(table).select("id").eq(col, val).eq("tenant_id", ids.tenant).single()).data!.id as string;
  ids.supplier = await q("parties", "name", "Kisan Fertilisers Ltd");
  // a brand-new customer each run (through the real Add Party action), so receipts only ever meet this run's invoices
  const fd = new FormData();
  Object.entries({ name: `Test Customer ${tag}`, party_type: "CUSTOMER", is_customer: "true", gst_status: "UNREGISTERED", state_code: "27",
                   credit_limit: "100000", credit_days: "30" }).forEach(([k, v]) => fd.set(k, v));
  const added = await addParty({}, fd);
  mustSucceed(added, "addParty");
  ids.customer = await q("parties", "name", `Test Customer ${tag}`);
  ids.main = await q("locations", "name", "Main Godown");
  ids.urea = await q("products", "name", "Urea 45kg");
});

describe("purchase -> sale -> receipt -> credit note", () => {
  const s: Record<string, string> = {};   // state shared between the ordered steps below

  it("creates and posts a purchase invoice: 100 bags @ 200 + 5% GST", async () => {
    const r = await createPurchaseInvoice({}, form({
      supplier_id: ids.supplier, supplier_type: "REGISTERED", invoice_date: today, supplier_invoice_no: `SUP-${tag}`,
      received_at_location: ids.main, is_interstate: false, payment_terms_days: 30,
    }, [{ product_id: ids.urea, hsn_code: "3102", batch_number: `B-${tag}`, received_qty: 100, free_qty: 0, unit_of_measure: "BAG",
          unit_price: 200, discount_percent: 0, gst_rate: 5 }]));
    mustSucceed(r, "createPurchaseInvoice");
    s.pi = r.invoiceId!;
    const p = await postPurchaseInvoice(s.pi);
    mustSucceed(p, "postPurchaseInvoice");

    const inv = await admin.from("purchase_invoices").select("status, taxable_amount, net_payable, journal_voucher_id").eq("id", s.pi).single();
    expect(inv.data).toMatchObject({ status: "POSTED", taxable_amount: 20000, net_payable: 21000 });
    expect(inv.data!.journal_voucher_id).toBeTruthy();
    const b = await admin.from("batch_register").select("id, current_qty, landing_cost_per_unit").eq("batch_number", `B-${tag}`).single();
    s.batch = b.data!.id;
    expect(Number(b.data!.current_qty)).toBe(100);
    expect(Number(b.data!.landing_cost_per_unit)).toBe(200);
    expect(await stockOf(s.batch)).toBe(100);
  });

  it("creates and posts a sales invoice: 40 bags @ 300 on credit", async () => {
    const r = await createSalesInvoice({}, form({
      invoice_date: today, sale_type: "CREDIT", customer_id: ids.customer, from_location: ids.main,
      is_interstate: false, payment_terms_days: 15,
    }, [{ product_id: ids.urea, hsn_code: "3102", batch_id: s.batch, qty: 40, unit_of_measure: "BAG", unit_price: 300, discount_percent: 0, gst_rate: 5 }]));
    mustSucceed(r, "createSalesInvoice");
    s.si = r.invoiceId!;
    mustSucceed(await postSalesInvoice(s.si), "postSalesInvoice");

    const inv = await admin.from("sales_invoices").select("status, net_receivable, outstanding_amount").eq("id", s.si).single();
    expect(inv.data).toMatchObject({ status: "POSTED", net_receivable: 12600, outstanding_amount: 12600 });
    expect(await stockOf(s.batch)).toBe(60);
  });

  it("refuses to sell more than is in stock", async () => {
    const r = await createSalesInvoice({}, form({ invoice_date: today, sale_type: "CREDIT", customer_id: ids.customer, from_location: ids.main },
      [{ product_id: ids.urea, hsn_code: "3102", batch_id: s.batch, qty: 61, unit_of_measure: "BAG", unit_price: 300, gst_rate: 5 }]));
    mustSucceed(r, "createSalesInvoice (oversell draft)");
    const p = await postSalesInvoice(r.invoiceId!);
    expect(p.error ?? "").toMatch(/Insufficient stock/);
    expect(await stockOf(s.batch)).toBe(60);
  });

  it("records and posts a receipt of 5,000: the invoice balance falls", async () => {
    const r = await createPaymentReceipt({
      receipt_no: `RC-${tag}`, receipt_date: today, receipt_type: "RECEIPT", party_id: ids.customer, payment_mode: "UPI", amount: 5000,
      utr_no: `UTR${tag}`, bank_account_id: "",
    } as Parameters<typeof createPaymentReceipt>[0]);
    mustSucceed(r, "createPaymentReceipt");
    s.rc = (r.data as { id: string }).id;
    mustSucceed(await postPaymentReceipt(s.rc), "postPaymentReceipt");
    const inv = await admin.from("sales_invoices").select("amount_received, outstanding_amount").eq("id", s.si).single();
    expect(inv.data).toMatchObject({ amount_received: 5000, outstanding_amount: 7600 });
  });

  it("issues and posts a credit note for 10 returned bags: stock returns, balance falls", async () => {
    const line = await admin.from("sales_invoice_lines").select("id").eq("invoice_id", s.si).single();
    const r = await createCreditNote({}, form({
      original_invoice_id: s.si, credit_note_date: today, reason: "RETURN_OF_GOODS", goods_returned: true, return_to_location: ids.main,
    }, [{ product_id: ids.urea, original_line_id: line.data!.id, hsn_code: "3102", batch_id: s.batch, return_qty: 10,
          unit_of_measure: "BAG", unit_price: 300, gst_rate: 5 }]));
    mustSucceed(r, "createCreditNote");
    mustSucceed(await postCreditNote(r.cnId!), "postCreditNote");
    expect(await stockOf(s.batch)).toBe(70);
    const inv = await admin.from("sales_invoices").select("outstanding_amount").eq("id", s.si).single();
    expect(Number(inv.data!.outstanding_amount)).toBe(4450);   // 12600 - 5000 receipt - 3150 credit note
  });

  it("leaves the books balanced and the control accounts in step", async () => {
    const { data } = await admin.from("vw_trial_balance").select("period_debit, period_credit").eq("tenant_id", ids.tenant);
    const dr = (data ?? []).reduce((a, r) => a + Number(r.period_debit), 0);
    const cr = (data ?? []).reduce((a, r) => a + Number(r.period_credit), 0);
    expect(Math.round((dr - cr) * 100)).toBe(0);
    // debtors on the books == sum of what customers still owe on posted invoices
    const owed = await admin.from("sales_invoices").select("outstanding_amount").eq("tenant_id", ids.tenant).eq("status", "POSTED");
    expect(Math.round(await glBalance("1010"))).toBe(Math.round((owed.data ?? []).reduce((a, r) => a + Number(r.outstanding_amount), 0)));
  });

  it("a viewer cannot post documents", async () => {
    await signInAs("viewer");
    actAs("viewer");
    const r = await createSalesInvoice({}, form({ invoice_date: today, sale_type: "CASH", from_location: ids.main },
      [{ product_id: ids.urea, hsn_code: "3102", batch_id: s.batch, qty: 1, unit_of_measure: "BAG", unit_price: 300, gst_rate: 5 }]));
    // a viewer may be able to draft (RLS is tenant-wide) but must not be able to post - record what actually happens
    if (r.success) {
      const p = await postSalesInvoice(r.invoiceId!);
      expect({ posted: !!p.success }).toEqual({ posted: false });
    }
    actAs("admin");
  });
});
