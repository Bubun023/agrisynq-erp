import { adminClient } from "./session";

export const admin = adminClient();
export const tag = Date.now().toString(36).toUpperCase();
export const today = new Date().toISOString().slice(0, 10);

/** FormData with simple string fields plus a JSON "lines" field - the shape the older form-based actions expect. */
export function form(fields: Record<string, string | number | boolean>, lines?: unknown[]) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, String(v));
  if (lines) fd.set("lines", JSON.stringify(lines));
  return fd;
}

type Result = { success?: boolean; error?: string; fieldErrors?: Record<string, string[]> };
/** Fails with the action's own message (and field errors) instead of an opaque "expected true". */
export function mustSucceed(r: Result, what: string) {
  if (!r.success) throw new Error(`${what} failed: ${r.error ?? JSON.stringify(r.fieldErrors)}`);
}

export async function tenantId() {
  return (await admin.from("tenants").select("id").eq("slug", "demo").single()).data!.id as string;
}
export async function idByName(table: string, name: string) {
  const { data, error } = await admin.from(table).select("id").eq("name", name).eq("tenant_id", await tenantId()).single();
  if (error || !data) throw new Error(`${table} "${name}" not found: ${error?.message}`);
  return data.id as string;
}
export async function stockOf(opts: { batchId?: string; productId?: string; locationId?: string }) {
  let q = admin.from("stock_balance").select("balance_qty");
  if (opts.batchId) q = q.eq("batch_id", opts.batchId);
  if (opts.productId) q = q.eq("product_id", opts.productId);
  if (opts.locationId) q = q.eq("location_id", opts.locationId);
  const { data } = await q;
  return (data ?? []).reduce((s, r) => s + Number(r.balance_qty), 0);
}
export async function glBalance(code: string) {
  const { data } = await admin.from("vw_trial_balance").select("period_debit, period_credit").eq("account_code", code).eq("tenant_id", await tenantId());
  return Math.round((data ?? []).reduce((s, r) => s + Number(r.period_debit) - Number(r.period_credit), 0) * 100) / 100;
}

/**
 * Builds fresh stock through the real actions: a location, a product and a posted purchase invoice of `qty` bags.
 * Returns the ids so a test can sell / adjust / transfer it without depending on other tests or leftovers.
 */
export async function seedStock(label: string, qty = 100, unitPrice = 10) {
  const { addLocation } = await import("@/actions/locations");
  const { addProduct } = await import("@/actions/products");
  const { createPurchaseInvoice, postPurchaseInvoice } = await import("@/actions/purchase-invoices");
  const key = `${label}${tag}`;
  mustSucceed(await addLocation({}, form({ name: `Loc ${key}`, code: key.slice(0, 20), location_type: "OWN", ownership: "OWN" })), "addLocation");
  mustSucceed(await addProduct({}, form({ name: `Prod ${key}`, product_code: key.slice(0, 20), category: "FERTILIZER", hsn_code: "3102",
    unit_of_measure: "BAG", gst_rate: 5, tax_status: "TAXABLE", mrp: 300, selling_price: 20, purchase_price: unitPrice, batch_required: true })), "addProduct");
  const location = await idByName("locations", `Loc ${key}`);
  const product = await idByName("products", `Prod ${key}`);
  const supplier = await idByName("parties", "Kisan Fertilisers Ltd");
  const pi = await createPurchaseInvoice({}, form({ supplier_id: supplier, supplier_type: "REGISTERED", invoice_date: today,
    supplier_invoice_no: `S-${key}`, received_at_location: location, is_interstate: false },
    [{ product_id: product, hsn_code: "3102", batch_number: `B-${key}`, received_qty: qty, free_qty: 0, unit_of_measure: "BAG", unit_price: unitPrice, gst_rate: 5 }]));
  mustSucceed(pi, "createPurchaseInvoice");
  mustSucceed(await postPurchaseInvoice(pi.invoiceId!), "postPurchaseInvoice");
  const batch = (await admin.from("batch_register").select("id").eq("batch_number", `B-${key}`).single()).data!.id as string;
  return { location, product, supplier, batch, key };
}
