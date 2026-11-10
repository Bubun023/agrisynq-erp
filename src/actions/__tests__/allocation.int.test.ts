/** Manual receipt allocation: choose which invoices a receipt settles (instead of oldest-first). */
import { beforeAll, describe, expect, it } from "vitest";
import { signInAs, actAs } from "@/test/int/session";
import { admin, tag, today, form, mustSucceed, idByName, seedStock } from "@/test/int/helpers";
import { addParty } from "@/actions/parties";
import { createSalesInvoice, postSalesInvoice } from "@/actions/sales-invoices";
import { createPaymentReceipt, postPaymentReceipt } from "@/actions/accounting";
import { getReceiptAllocationInfo, saveReceiptAllocations } from "@/actions/receipt-allocations";

const ids = {} as Record<string, string>;
let stock: Awaited<ReturnType<typeof seedStock>>;

async function invoice(qty: number) {
  const r = await createSalesInvoice({}, form({ invoice_date: today, sale_type: "CREDIT", customer_id: ids.customer, from_location: stock.location, is_interstate: false },
    [{ product_id: stock.product, hsn_code: "3102", batch_id: stock.batch, qty, unit_of_measure: "BAG", unit_price: 300, gst_rate: 5 }]));
  mustSucceed(r, "createSalesInvoice");
  mustSucceed(await postSalesInvoice(r.invoiceId!), "postSalesInvoice");
  return r.invoiceId!;
}
async function receipt(amount: number, n: string) {
  const r = await createPaymentReceipt({ receipt_no: `AL-${n}-${tag}`, receipt_date: today, receipt_type: "RECEIPT", party_id: ids.customer, payment_mode: "UPI", amount, utr_no: `U${n}${tag}`, bank_account_id: "" } as Parameters<typeof createPaymentReceipt>[0]);
  mustSucceed(r, "createPaymentReceipt");
  return (r.data as { id: string }).id;
}
const outstanding = async (id: string) => Number((await admin.from("sales_invoices").select("outstanding_amount").eq("id", id).single()).data!.outstanding_amount);

beforeAll(async () => {
  for (const u of ["admin", "viewer"] as const) await signInAs(u);
  actAs("admin");
  mustSucceed(await addParty({}, form({ name: `Alloc Cust ${tag}`, party_type: "CUSTOMER", is_customer: true, gst_status: "UNREGISTERED" })), "addParty");
  ids.customer = await idByName("parties", `Alloc Cust ${tag}`);
  stock = await seedStock("AL", 100, 10);
  ids.older = await invoice(10);     // 3,150
  ids.newer = await invoice(10);     // 3,150
});

describe("manual receipt allocation", () => {
  it("lists the party's open invoices", async () => {
    const rc = await receipt(2000, "1");
    const info = await getReceiptAllocationInfo(rc);
    expect(info.error).toBeUndefined();
    expect(info.receipt).toMatchObject({ amount: 2000, type: "RECEIPT" });
    expect(info.invoices.map((i) => i.id).sort()).toEqual([ids.older, ids.newer].sort());
    expect(info.invoices.every((i) => i.outstanding === 3150)).toBe(true);
  });

  it("settles the invoice the user picked, not the oldest", async () => {
    const rc = await receipt(2000, "2");
    mustSucceed({ success: !(await saveReceiptAllocations(rc, [{ invoiceId: ids.newer, amount: 2000 }])).error }, "save allocation");
    expect((await getReceiptAllocationInfo(rc)).invoices.find((i) => i.id === ids.newer)!.allocated).toBe(2000);
    mustSucceed(await postPaymentReceipt(rc), "postPaymentReceipt");
    expect(await outstanding(ids.newer)).toBe(1150);
    expect(await outstanding(ids.older)).toBe(3150);          // automatic settlement would have been free to take this one
  });

  it("refuses bad allocations", async () => {
    const rc = await receipt(1000, "3");
    expect((await saveReceiptAllocations(rc, [{ invoiceId: ids.older, amount: 1500 }])).error ?? "").toMatch(/more than the receipt amount/);
    expect((await saveReceiptAllocations(rc, [{ invoiceId: ids.newer, amount: 1151 }])).error ?? "").toMatch(/still outstanding|more than/);
    expect((await saveReceiptAllocations(rc, [{ invoiceId: ids.older, amount: 400 }, { invoiceId: ids.older, amount: 400 }])).error ?? "").toMatch(/once/);
    expect((await saveReceiptAllocations(rc, [{ invoiceId: "00000000-0000-0000-0000-000000000000", amount: 5 }])).error ?? "").toMatch(/not open/);
    expect((await admin.from("receipt_allocations").select("id").eq("receipt_id", rc)).data).toHaveLength(0);   // nothing half-saved
  });

  it("clearing the allocation falls back to automatic settlement on posting", async () => {
    const rc = await receipt(1000, "4");
    mustSucceed({ success: !(await saveReceiptAllocations(rc, [{ invoiceId: ids.older, amount: 400 }])).error }, "save a partial allocation");
    mustSucceed({ success: !(await saveReceiptAllocations(rc, [])).error }, "clear");
    expect((await admin.from("receipt_allocations").select("id").eq("receipt_id", rc)).data).toHaveLength(0);
    mustSucceed(await postPaymentReceipt(rc), "post with no allocation -> FIFO");
    // both invoices share a date, so which one is "oldest" is a tie - what matters is that 1,000 was applied automatically
    expect((await outstanding(ids.older)) + (await outstanding(ids.newer))).toBe(3150 + 1150 - 1000);
  });

  it("a posted receipt can no longer be allocated, and a viewer cannot allocate", async () => {
    const rc = await receipt(100, "5");
    actAs("viewer");
    expect((await saveReceiptAllocations(rc, [{ invoiceId: ids.older, amount: 100 }])).error ?? "").toBeTruthy();
    actAs("admin");
    mustSucceed(await postPaymentReceipt(rc), "post");
    expect((await saveReceiptAllocations(rc, [{ invoiceId: ids.older, amount: 100 }])).error ?? "").toMatch(/draft/i);
  });
});
