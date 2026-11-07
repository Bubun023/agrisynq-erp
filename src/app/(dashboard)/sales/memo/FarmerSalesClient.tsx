"use client";

import { useState, useTransition, useMemo } from "react";
import { Sprout, Plus, X, ShieldAlert, CheckCircle } from "lucide-react";
import { toast } from "sonner";
import { createFarmerSale, postFarmerSale } from "@/actions/farmer-sales";
import { formatCurrency, formatDate, cn } from "@/lib/utils";

type FarmerSale = {
  id: string; sale_number: string; sale_date: string; status: string;
  season: string | null; farmer_id: string; farmer_name: string;
  farmer_phone: string | null; farmer_aadhaar_last4: string | null;
  farmers: { first_name: string; last_name: string } | null;
  product_id: string;
  products: { name: string; product_code: string } | null;
  qty_sold: number; unit_of_measure: string;
  selling_price_per_unit: number; subsidy_per_unit: number;
  gross_amount: number; total_subsidy_amount: number;
  farmer_payable_amount: number; net_amount: number;
  cash_received: number; credit_amount: number;
  gst_rate: number; gst_amount: number;
  subsidy_type: string; pos_transaction_id: string | null;
  fms_dealer_id: string | null; created_at: string; posted_at: string | null;
};

const STATUS_CLASS: Record<string, string> = {
  DRAFT: "badge-warning", POS_PENDING: "badge-warning", POS_RECORDED: "badge-info",
  POSTED: "badge-success", SUBSIDY_CLAIMED: "badge", SUBSIDY_RECEIVED: "badge-success", CANCELLED: "badge-danger",
};
const SUBSIDY_TYPES = ["NONE","NEEM_COATED_UREA","NBS_FERTILIZER","STATE_SUBSIDY"];
const GST_RATES = ["0","5","12","18","28"];
const UOM_LIST = ["BAG","KG","LTR","ML","NOS","BOX","TON","MT","QTL","PKT"];

export default function FarmerSalesClient({ initialSales }: { initialSales: FarmerSale[] }) {
  const [sales, setSales] = useState(initialSales);
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [search, setSearch] = useState("");
  const [showPanel, setShowPanel] = useState(false);
  const [isPending, startTransition] = useTransition();

  /* form state */
  const [qty, setQty] = useState("");
  const [sellingPrice, setSellingPrice] = useState("");
  const [subsidyPerUnit, setSubsidyPerUnit] = useState("0");
  const [gstRate, setGstRate] = useState("0");
  const [cashReceived, setCashReceived] = useState("0");

  /* live calc */
  const calc = useMemo(() => {
    const q = parseFloat(qty) || 0;
    const sp = parseFloat(sellingPrice) || 0;
    const sub = parseFloat(subsidyPerUnit) || 0;
    const gr = parseFloat(gstRate) || 0;
    const cash = parseFloat(cashReceived) || 0;
    const gross = q * sp;
    const totalSubsidy = q * sub;
    const farmerPayable = q * (sp - sub);
    const gstAmt = (farmerPayable * gr) / 100;
    const netAmount = farmerPayable + gstAmt;
    const credit = Math.max(0, netAmount - cash);
    return { gross, totalSubsidy, farmerPayable, gstAmt, netAmount, credit };
  }, [qty, sellingPrice, subsidyPerUnit, gstRate, cashReceived]);

  /* stats */
  const postedSales = sales.filter(s => s.status === "POSTED");
  const totalSubsidy = postedSales.reduce((a, s) => a + s.total_subsidy_amount, 0);
  const posPending = sales.filter(s => s.status === "POS_PENDING").length;

  /* filters */
  const filtered = useMemo(() => sales.filter(s => {
    if (statusFilter !== "ALL" && s.status !== statusFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      return (s.farmer_name?.toLowerCase().includes(q) ||
        s.sale_number?.toLowerCase().includes(q) ||
        (s.products?.name ?? "").toLowerCase().includes(q));
    }
    return true;
  }), [sales, statusFilter, search]);

  /* post */
  function handlePost(id: string, num: string) {
    if (!confirm(`Post farmer sale ${num}? This will deduct stock and cannot be undone.`)) return;
    startTransition(async () => {
      const res = await postFarmerSale(id);
      if (res.success) {
        toast.success(`Farmer sale ${num} posted. Stock updated.`);
        setSales(prev => prev.map(s => s.id === id ? { ...s, status: "POSTED" } : s));
      } else toast.error(res.error ?? "Failed.");
    });
  }

  /* create */
  function handleCreate(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    startTransition(async () => {
      const res = await createFarmerSale(undefined as never, fd);
      if (res.success) {
        toast.success(`Farmer sale ${res.saleNumber} recorded.`);
        setShowPanel(false);
        setQty(""); setSellingPrice(""); setSubsidyPerUnit("0"); setGstRate("0"); setCashReceived("0");
      } else toast.error(res.error ?? "Failed to record sale.");
    });
  }

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Farmer Sales</h1>
          <p className="page-subtitle">iFMS/FMS-compliant fertiliser sales to farmers — PoS transaction required</p>
        </div>
        <button onClick={() => setShowPanel(true)} className="btn btn-primary flex items-center gap-2">
          <Plus className="w-4 h-4" /> New Farmer Sale
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="card p-4">
          <p className="text-xs text-ink-muted uppercase tracking-wide">Total Sales</p>
          <p className="text-2xl font-bold text-ink mt-1">{sales.length}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-ink-muted uppercase tracking-wide">Posted</p>
          <p className="text-2xl font-bold text-leaf-700 mt-1">{postedSales.length}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-ink-muted uppercase tracking-wide">Total Subsidy (Posted)</p>
          <p className="text-2xl font-bold text-gold-500 mt-1">{formatCurrency(totalSubsidy)}</p>
        </div>
        <div className={cn("card p-4", posPending > 0 ? "border-amber-300 bg-amber-50" : "")}>
          <p className="text-xs text-ink-muted uppercase tracking-wide">PoS Pending</p>
          <p className={cn("text-2xl font-bold mt-1", posPending > 0 ? "text-amber-700" : "text-ink")}>{posPending}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search farmer, sale number, product…"
          className="border border-surface-border rounded-lg px-3 py-2 text-sm w-72 focus:outline-none focus:ring-2 focus:ring-leaf-600" />
        <div className="flex gap-1 flex-wrap">
          {["ALL","POS_PENDING","POS_RECORDED","POSTED","SUBSIDY_CLAIMED"].map(s => (
            <button key={s} onClick={() => setStatusFilter(s)}
              className={cn("px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors", statusFilter === s
                ? "bg-navy-950 text-white border-navy-950"
                : "border-surface-border text-ink-muted hover:bg-surface-subtle")}>
              {s.replace("_", " ")}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      {filtered.length === 0 ? (
        <div className="card p-12 flex flex-col items-center gap-4 text-center">
          <div className="p-4 rounded-2xl bg-surface-subtle"><Sprout className="w-8 h-8 text-ink-faint" strokeWidth={1.5} /></div>
          <p className="text-sm text-ink-muted">No farmer sales found</p>
        </div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="data-table w-full text-sm">
            <thead>
              <tr>
                <th>Sale No</th><th>Date</th><th>Farmer</th><th>Aadhaar</th><th>Product</th>
                <th>Qty</th><th>Selling Price</th><th>Subsidy/unit</th>
                <th>Farmer Pays</th><th>Net Amount</th><th>PoS ID</th><th>Status</th><th>Action</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(s => (
                <tr key={s.id}>
                  <td className="font-mono text-leaf-700 text-xs">{s.sale_number}</td>
                  <td>{formatDate(s.sale_date)}</td>
                  <td>
                    <div className="font-medium">{s.farmer_name}</div>
                    <div className="text-xs text-ink-muted">{s.farmer_phone ?? ""}</div>
                  </td>
                  <td className="font-mono text-xs text-ink-muted">
                    {s.farmer_aadhaar_last4 ? `XXXX-XXXX-${s.farmer_aadhaar_last4}` : "—"}
                  </td>
                  <td>
                    <div>{s.products?.name ?? "—"}</div>
                    <div className="text-xs text-ink-muted">{s.products?.product_code ?? ""}</div>
                  </td>
                  <td>{s.qty_sold} {s.unit_of_measure}</td>
                  <td>{formatCurrency(s.selling_price_per_unit)}</td>
                  <td className="text-gold-500">{formatCurrency(s.subsidy_per_unit)}</td>
                  <td>{formatCurrency(s.farmer_payable_amount)}</td>
                  <td className="font-medium">{formatCurrency(s.net_amount)}</td>
                  <td className="font-mono text-xs max-w-[120px] truncate">
                    {s.pos_transaction_id ?? <span className="text-amber-600">Pending</span>}
                  </td>
                  <td><span className={cn("badge text-xs", STATUS_CLASS[s.status] ?? "badge")}>{s.status.replace("_", " ")}</span></td>
                  <td>
                    {(s.status === "POS_PENDING" || s.status === "POS_RECORDED") && (
                      <button onClick={() => handlePost(s.id, s.sale_number)} disabled={isPending}
                        className="text-xs px-2 py-1 bg-leaf-700 text-white rounded hover:bg-leaf-700/90 disabled:opacity-50">
                        Post
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── New Farmer Sale Slide-over ── */}
      {showPanel && (
        <>
          <div className="fixed inset-0 bg-black/40 z-40" onClick={() => setShowPanel(false)} />
          <div className="fixed inset-y-0 right-0 z-50 w-full max-w-2xl bg-white shadow-xl flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-surface-border">
              <div>
                <h2 className="text-base font-semibold text-ink">New Farmer Sale</h2>
                <p className="text-xs text-ink-muted">FMS/iFMS subsidised fertiliser sale record</p>
              </div>
              <button onClick={() => setShowPanel(false)} className="text-ink-muted hover:text-ink">
                <X className="w-5 h-5" />
              </button>
            </div>

            <form id="farmer-sale-form" onSubmit={handleCreate} className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
              {/* Compliance notice */}
              <div className="flex items-start gap-3 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                <ShieldAlert className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
                <div className="text-xs text-amber-800">
                  <p className="font-semibold">FMS Compliance Required</p>
                  <p>Subsidised fertiliser sales must have a valid PoS transaction ID from the FMS/iFMS device.
                  Duplicate PoS IDs are rejected — each transaction may only be recorded once.</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="form-label">Farmer UUID *</label>
                  <input name="farmer_id" required placeholder="Farmer UUID"
                    className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-leaf-600" />
                </div>
                <div>
                  <label className="form-label">Product UUID *</label>
                  <input name="product_id" required placeholder="Product UUID"
                    className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-leaf-600" />
                </div>
                <div>
                  <label className="form-label">HSN Code *</label>
                  <input name="hsn_code" required className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-leaf-600" />
                </div>
                <div>
                  <label className="form-label">Sale Location UUID *</label>
                  <input name="sale_at_location" required placeholder="Location UUID"
                    className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-leaf-600" />
                </div>
                <div>
                  <label className="form-label">Sale Date *</label>
                  <input name="sale_date" type="date" required defaultValue={new Date().toISOString().split("T")[0]}
                    className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-leaf-600" />
                </div>
                <div>
                  <label className="form-label">Season</label>
                  <input name="season" placeholder="e.g. Kharif 2026"
                    className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-leaf-600" />
                </div>
                <div>
                  <label className="form-label">Financial Year</label>
                  <input name="financial_year" placeholder="e.g. 2026-27"
                    className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-leaf-600" />
                </div>
                <div>
                  <label className="form-label">Batch Number</label>
                  <input name="batch_number"
                    className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-leaf-600" />
                </div>
              </div>

              {/* Quantities & pricing */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="form-label">Quantity Sold *</label>
                  <input name="qty_sold" type="number" min={0.001} step="any" required
                    value={qty} onChange={e => setQty(e.target.value)}
                    className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-leaf-600" />
                </div>
                <div>
                  <label className="form-label">UoM</label>
                  <select name="unit_of_measure"
                    className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-leaf-600">
                    {UOM_LIST.map(u => <option key={u}>{u}</option>)}
                  </select>
                </div>
                <div>
                  <label className="form-label">MRP per Unit (₹)</label>
                  <input name="mrp_per_unit" type="number" min={0} step="any"
                    className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-leaf-600" />
                </div>
                <div>
                  <label className="form-label">Selling Price / Unit (₹) *</label>
                  <input name="selling_price_per_unit" type="number" min={0} step="any" required
                    value={sellingPrice} onChange={e => setSellingPrice(e.target.value)}
                    className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-leaf-600" />
                </div>
                <div>
                  <label className="form-label">Subsidy / Unit (₹)</label>
                  <input name="subsidy_per_unit" type="number" min={0} step="any" defaultValue={0}
                    value={subsidyPerUnit} onChange={e => setSubsidyPerUnit(e.target.value)}
                    className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-leaf-600" />
                </div>
                <div>
                  <label className="form-label">GST Rate %</label>
                  <div className="flex gap-1 mt-1">
                    {GST_RATES.map(r => (
                      <button key={r} type="button" onClick={() => setGstRate(r)}
                        className={cn("px-2.5 py-1.5 text-xs rounded border", gstRate === r
                          ? "bg-navy-950 text-white border-navy-950"
                          : "border-surface-border text-ink-muted")}>
                        {r}%
                      </button>
                    ))}
                  </div>
                  <input type="hidden" name="gst_rate" value={gstRate} />
                </div>
              </div>

              {/* Subsidy type */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="form-label">Subsidy Type</label>
                  <select name="subsidy_type"
                    className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-leaf-600">
                    {SUBSIDY_TYPES.map(t => <option key={t} value={t}>{t.replace(/_/g, " ")}</option>)}
                  </select>
                </div>
                <div>
                  <label className="form-label">Subsidy Scheme</label>
                  <input name="subsidy_scheme"
                    className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-leaf-600" />
                </div>
              </div>

              {/* FMS fields */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="form-label">FMS Dealer ID</label>
                  <input name="fms_dealer_id"
                    className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-leaf-600" />
                </div>
                <div>
                  <label className="form-label">FMS Product Code</label>
                  <input name="fms_product_code"
                    className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-leaf-600" />
                </div>
                <div>
                  <label className="form-label">PoS Transaction ID</label>
                  <input name="pos_transaction_id" placeholder="From iFMS/FMS device"
                    className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-leaf-600" />
                </div>
                <div>
                  <label className="form-label">PoS Device ID</label>
                  <input name="pos_device_id"
                    className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-leaf-600" />
                </div>
                <div>
                  <label className="form-label">Cash Received (₹)</label>
                  <input name="cash_received" type="number" min={0} step="any" defaultValue={0}
                    value={cashReceived} onChange={e => setCashReceived(e.target.value)}
                    className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-leaf-600" />
                </div>
              </div>

              <div>
                <label className="form-label">Narration</label>
                <textarea name="narration" rows={2}
                  className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-leaf-600" />
              </div>

              {/* Live calc */}
              <div className="bg-surface-subtle rounded-lg p-4 space-y-2 text-sm border border-surface-border">
                <p className="text-xs font-semibold text-ink-muted uppercase tracking-wide mb-2">Live Calculation</p>
                <div className="flex justify-between text-ink-muted">
                  <span>Gross Amount</span><span>{formatCurrency(calc.gross)}</span>
                </div>
                <div className="flex justify-between text-gold-500">
                  <span>Total Subsidy</span><span>− {formatCurrency(calc.totalSubsidy)}</span>
                </div>
                <div className="flex justify-between text-ink-muted border-t border-surface-border pt-2">
                  <span>Farmer Payable</span><span>{formatCurrency(calc.farmerPayable)}</span>
                </div>
                <div className="flex justify-between text-ink-muted">
                  <span>GST ({gstRate}%)</span><span>{formatCurrency(calc.gstAmt)}</span>
                </div>
                <div className="flex justify-between font-semibold text-ink border-t border-surface-border pt-2">
                  <span>Net Amount</span><span>{formatCurrency(calc.netAmount)}</span>
                </div>
                <div className="flex justify-between text-leaf-700">
                  <span>Cash Received</span><span>{formatCurrency(parseFloat(cashReceived) || 0)}</span>
                </div>
                {calc.credit > 0 && (
                  <div className="flex justify-between text-amber-700 font-medium">
                    <span>Credit Balance</span><span>{formatCurrency(calc.credit)}</span>
                  </div>
                )}
              </div>
            </form>

            <div className="px-6 py-4 border-t border-surface-border flex justify-end gap-3">
              <button type="button" onClick={() => setShowPanel(false)}
                className="btn border border-surface-border text-ink-muted hover:bg-surface-subtle">Cancel</button>
              <button type="button" disabled={isPending}
                onClick={() => {
                  const form = document.querySelector("#farmer-sale-form") as HTMLFormElement;
                  if (form) form.requestSubmit();
                }}
                className="btn btn-primary flex items-center gap-2 disabled:opacity-50">
                <CheckCircle className="w-4 h-4" />
                {isPending ? "Recording…" : "Record Farmer Sale"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
