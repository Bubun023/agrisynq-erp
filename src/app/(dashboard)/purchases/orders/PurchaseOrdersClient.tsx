"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Plus, X, Search, Trash2, Loader2, ShoppingCart } from "lucide-react";
import { toast } from "sonner";
import { createPurchaseOrder, updatePOStatus } from "@/actions/purchase-orders";
import { formatDate, formatCurrency } from "@/lib/utils";

type PO = {
  id: string;
  po_number: string;
  po_date: string;
  status: string;
  reference_no: string | null;
  parties: { name: string } | null;
  locations: { name: string; code: string | null } | null;
  expected_delivery_date: string | null;
  total_taxable_amount: number;
  total_gst_amount: number;
  total_amount: number;
  payment_terms_days: number;
};

type LineItem = {
  id: string; // temp client-side id
  product_id: string;
  product_name: string;
  description: string;
  hsn_code: string;
  ordered_qty: number;
  unit_of_measure: string;
  unit_price: number;
  discount_percent: number;
  gst_rate: number;
};

const STATUS_BADGE: Record<string, string> = {
  DRAFT:              "badge",
  SENT:               "badge-info",
  ACKNOWLEDGED:       "badge-success",
  PARTIALLY_RECEIVED: "badge-warning",
  FULLY_RECEIVED:     "badge-success",
  CLOSED:             "badge",
  CANCELLED:          "badge-danger",
};

const STATUS_ACTIONS: Record<string, { label: string; next: "SENT" | "ACKNOWLEDGED" | "CLOSED" | "CANCELLED" }[]> = {
  DRAFT:        [{ label: "Mark Sent", next: "SENT" }, { label: "Cancel", next: "CANCELLED" }],
  SENT:         [{ label: "Acknowledge", next: "ACKNOWLEDGED" }, { label: "Cancel", next: "CANCELLED" }],
  ACKNOWLEDGED: [{ label: "Close PO", next: "CLOSED" }],
};

export default function PurchaseOrdersClient({ initialOrders }: { initialOrders: PO[] }) {
  const router = useRouter();
  const [orders]                     = useState(initialOrders);
  const [search, setSearch]           = useState("");
  const [statusFilter, setStatus]     = useState("ALL");
  const [isOpen, setIsOpen]           = useState(false);
  const [isPending, startTransition]  = useTransition();

  // Line items state
  const [lines, setLines] = useState<LineItem[]>([]);
  const addLine = () => setLines((prev) => [...prev, {
    id: crypto.randomUUID(), product_id: "", product_name: "", description: "",
    hsn_code: "", ordered_qty: 1, unit_of_measure: "BAG",
    unit_price: 0, discount_percent: 0, gst_rate: 0,
  }]);
  const removeLine = (id: string) => setLines((prev) => prev.filter((l) => l.id !== id));
  const updateLine = (id: string, field: keyof LineItem, value: string | number) =>
    setLines((prev) => prev.map((l) => l.id === id ? { ...l, [field]: value } : l));

  // Computed totals
  const totals = lines.reduce((acc, l) => {
    const taxable = l.ordered_qty * l.unit_price * (1 - l.discount_percent / 100);
    const gst = taxable * l.gst_rate / 100;
    return { taxable: acc.taxable + taxable, gst: acc.gst + gst };
  }, { taxable: 0, gst: 0 });

  const filteredOrders = orders.filter((o) => {
    const q = search.toLowerCase();
    const matchSearch = o.po_number.toLowerCase().includes(q)
      || (o.parties?.name ?? "").toLowerCase().includes(q)
      || (o.reference_no ?? "").toLowerCase().includes(q);
    const matchStatus = statusFilter === "ALL" || o.status === statusFilter;
    return matchSearch && matchStatus;
  });

  const handleCreate = (formData: FormData) => {
    if (lines.length === 0) { toast.error("Add at least one product line."); return; }

    const linesPayload = lines.map((l) => ({
      product_id:      l.product_id,
      description:     l.description,
      ordered_qty:     l.ordered_qty,
      unit_of_measure: l.unit_of_measure,
      unit_price:      l.unit_price,
      discount_percent:l.discount_percent,
      gst_rate:        l.gst_rate,
    }));
    formData.set("lines", JSON.stringify(linesPayload));

    startTransition(async () => {
      const result = await createPurchaseOrder({}, formData);
      if (result.success) {
        toast.success(`Purchase Order ${result.poNumber} created.`);
        setIsOpen(false);
        setLines([]);
        router.refresh();
      } else if (result.fieldErrors) {
        toast.error(Object.values(result.fieldErrors).flat()[0] ?? "Validation error.");
      } else {
        toast.error(result.error ?? "Failed to create PO.");
      }
    });
  };

  const handleStatusUpdate = async (poId: string, next: "SENT" | "ACKNOWLEDGED" | "CLOSED" | "CANCELLED") => {
    const res = await updatePOStatus(poId, next);
    if (res.success) { toast.success("PO status updated."); router.refresh(); }
    else toast.error(res.error ?? "Failed.");
  };

  const today = new Date().toISOString().split("T")[0];

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Purchase Orders</h1>
          <p className="page-subtitle">Manage supplier procurement commitments</p>
        </div>
        <button className="btn btn-primary inline-flex items-center gap-2" onClick={() => setIsOpen(true)}>
          <Plus className="w-4 h-4" />New Purchase Order
        </button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search PO no., supplier, reference…"
            className="w-full pl-9 pr-4 py-2 bg-white border border-surface-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-navy-500/20 shadow-sm" />
        </div>
        <div className="flex gap-2 flex-wrap">
          {["ALL","DRAFT","SENT","ACKNOWLEDGED","PARTIALLY_RECEIVED","FULLY_RECEIVED","CLOSED","CANCELLED"].map((s) => (
            <button key={s} onClick={() => setStatus(s)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                statusFilter === s ? "bg-navy-950 text-white border-navy-950" : "border-surface-border text-ink-muted hover:bg-surface-subtle"
              }`}>
              {s === "ALL" ? "All" : s.replace(/_/g," ")}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="bg-surface-subtle text-ink-muted font-medium border-b border-surface-border">
              <tr>
                <th className="px-4 py-3">PO No.</th>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Supplier</th>
                <th className="px-4 py-3">Reference</th>
                <th className="px-4 py-3">Exp. Delivery</th>
                <th className="px-4 py-3 text-right">Taxable</th>
                <th className="px-4 py-3 text-right">GST</th>
                <th className="px-4 py-3 text-right">Total</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border text-ink">
              {filteredOrders.length === 0 ? (
                <tr><td colSpan={10} className="px-4 py-12 text-center">
                  <ShoppingCart className="w-10 h-10 text-ink-faint mx-auto mb-2" strokeWidth={1.5} />
                  <p className="text-ink-muted text-sm">{search ? "No POs match." : "No purchase orders yet."}</p>
                  {!search && <button onClick={() => setIsOpen(true)} className="mt-3 text-sm text-leaf-600 hover:underline">Create your first PO →</button>}
                </td></tr>
              ) : filteredOrders.map((po) => (
                <tr key={po.id} className="hover:bg-surface-subtle/50 transition-colors">
                  <td className="px-4 py-3 font-mono text-xs font-semibold text-leaf-700">{po.po_number}</td>
                  <td className="px-4 py-3 text-xs text-ink-muted whitespace-nowrap">{formatDate(po.po_date)}</td>
                  <td className="px-4 py-3 font-medium text-ink">{po.parties?.name ?? "—"}</td>
                  <td className="px-4 py-3 text-xs text-ink-muted">{po.reference_no ?? "—"}</td>
                  <td className="px-4 py-3 text-xs text-ink-muted whitespace-nowrap">{po.expected_delivery_date ? formatDate(po.expected_delivery_date) : "—"}</td>
                  <td className="px-4 py-3 text-right text-xs">{formatCurrency(po.total_taxable_amount)}</td>
                  <td className="px-4 py-3 text-right text-xs text-ink-muted">{formatCurrency(po.total_gst_amount)}</td>
                  <td className="px-4 py-3 text-right font-semibold">{formatCurrency(po.total_amount)}</td>
                  <td className="px-4 py-3"><span className={`${STATUS_BADGE[po.status] ?? "badge"} text-xs`}>{po.status.replace(/_/g," ")}</span></td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1">
                      {(STATUS_ACTIONS[po.status] ?? []).map((a) => (
                        <button key={a.next} onClick={() => handleStatusUpdate(po.id, a.next)}
                          className={`text-xs px-2 py-1 rounded border transition-colors ${
                            a.next === "CANCELLED" ? "border-danger-200 text-danger-600 hover:bg-danger-50" : "border-surface-border text-ink-muted hover:bg-surface-subtle"
                          }`}>{a.label}</button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create PO Slide-over */}
      {isOpen && <div className="fixed inset-0 bg-black/20 z-40" onClick={() => setIsOpen(false)} />}
      <div className={`fixed inset-y-0 right-0 w-[680px] bg-white shadow-xl z-50 flex flex-col transform transition-transform duration-300 ${isOpen ? "translate-x-0" : "translate-x-full"}`}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-border bg-surface-subtle shrink-0">
          <h2 className="text-base font-semibold text-ink">New Purchase Order</h2>
          <button onClick={() => setIsOpen(false)}><X className="w-5 h-5 text-ink-muted" /></button>
        </div>
        <div className="flex-1 overflow-y-auto">
          <form action={handleCreate} className="px-6 py-4 space-y-5">
            {/* Header */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="form-label">Supplier ID * <span className="text-ink-faint text-xs">(UUID)</span></label>
                <input name="supplier_id" required placeholder="Supplier UUID"
                  className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-navy-500/20" />
              </div>
              <div>
                <label className="form-label">PO Date *</label>
                <input type="date" name="po_date" defaultValue={today} required
                  className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-500/20" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="form-label">Expected Delivery</label>
                <input type="date" name="expected_delivery_date"
                  className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-500/20" />
              </div>
              <div>
                <label className="form-label">Deliver To Location (UUID)</label>
                <input name="deliver_to_location" placeholder="Location UUID"
                  className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-navy-500/20" />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div>
                <label className="form-label">Payment Terms (days)</label>
                <input type="number" name="payment_terms_days" defaultValue="30" min="0" max="365"
                  className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-500/20" />
              </div>
              <div>
                <label className="form-label">Discount %</label>
                <input type="number" name="discount_percent" defaultValue="0" min="0" max="100" step="0.01"
                  className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-500/20" />
              </div>
              <div>
                <label className="form-label">Reference No.</label>
                <input name="reference_no" placeholder="Your ref / supplier ref"
                  className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-500/20" />
              </div>
            </div>
            <div>
              <label className="form-label">Narration</label>
              <textarea name="narration" rows={2} placeholder="Purchase order remarks…"
                className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-500/20 resize-none" />
            </div>

            {/* Line Items */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="form-label mb-0">Line Items *</label>
                <button type="button" onClick={addLine}
                  className="inline-flex items-center gap-1 text-xs text-leaf-600 hover:underline font-medium">
                  <Plus className="w-3.5 h-3.5" />Add Line
                </button>
              </div>
              {lines.length === 0 ? (
                <div className="border border-dashed border-surface-border rounded-lg p-6 text-center">
                  <p className="text-sm text-ink-muted">No lines added yet.</p>
                  <button type="button" onClick={addLine} className="mt-2 text-xs text-leaf-600 hover:underline">+ Add first product</button>
                </div>
              ) : (
                <div className="space-y-2">
                  {lines.map((line, i) => (
                    <div key={line.id} className="border border-surface-border rounded-lg p-3 space-y-2 bg-surface-subtle/30">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-ink-muted">Line {i + 1}</span>
                        <button type="button" onClick={() => removeLine(line.id)}>
                          <Trash2 className="w-3.5 h-3.5 text-danger-400 hover:text-danger-600" />
                        </button>
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <div>
                          <label className="text-xs text-ink-muted">Product ID *</label>
                          <input value={line.product_id} onChange={(e) => updateLine(line.id, "product_id", e.target.value)}
                            placeholder="UUID" className="w-full border border-surface-border rounded px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-navy-500/20" />
                        </div>
                        <div>
                          <label className="text-xs text-ink-muted">Qty *</label>
                          <input type="number" value={line.ordered_qty} min={0.001} step={0.001}
                            onChange={(e) => updateLine(line.id, "ordered_qty", parseFloat(e.target.value))}
                            className="w-full border border-surface-border rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-navy-500/20" />
                        </div>
                        <div>
                          <label className="text-xs text-ink-muted">UoM *</label>
                          <input value={line.unit_of_measure} onChange={(e) => updateLine(line.id, "unit_of_measure", e.target.value)}
                            placeholder="BAG / KG / MT" className="w-full border border-surface-border rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-navy-500/20" />
                        </div>
                      </div>
                      <div className="grid grid-cols-3 gap-2">
                        <div>
                          <label className="text-xs text-ink-muted">Unit Price (ex-GST) *</label>
                          <input type="number" value={line.unit_price} min={0} step={0.01}
                            onChange={(e) => updateLine(line.id, "unit_price", parseFloat(e.target.value))}
                            className="w-full border border-surface-border rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-navy-500/20" />
                        </div>
                        <div>
                          <label className="text-xs text-ink-muted">Discount %</label>
                          <input type="number" value={line.discount_percent} min={0} max={100} step={0.01}
                            onChange={(e) => updateLine(line.id, "discount_percent", parseFloat(e.target.value))}
                            className="w-full border border-surface-border rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-navy-500/20" />
                        </div>
                        <div>
                          <label className="text-xs text-ink-muted">GST %</label>
                          <select value={line.gst_rate} onChange={(e) => updateLine(line.id, "gst_rate", parseFloat(e.target.value))}
                            className="w-full border border-surface-border rounded px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-navy-500/20 bg-white">
                            {[0,5,12,18,28].map((r) => <option key={r} value={r}>{r}%</option>)}
                          </select>
                        </div>
                      </div>
                      <div className="text-right text-xs text-ink-muted">
                        Taxable: <span className="font-medium text-ink">
                          {formatCurrency(line.ordered_qty * line.unit_price * (1 - line.discount_percent / 100))}
                        </span>
                        {" "} + GST: <span className="font-medium text-ink">
                          {formatCurrency(line.ordered_qty * line.unit_price * (1 - line.discount_percent / 100) * line.gst_rate / 100)}
                        </span>
                      </div>
                    </div>
                  ))}
                  {/* Footer totals */}
                  <div className="border-t border-surface-border pt-3 space-y-1 text-sm text-right">
                    <div className="flex justify-between text-ink-muted"><span>Taxable Amount</span><span>{formatCurrency(totals.taxable)}</span></div>
                    <div className="flex justify-between text-ink-muted"><span>GST</span><span>{formatCurrency(totals.gst)}</span></div>
                    <div className="flex justify-between font-semibold text-ink text-base"><span>Total</span><span>{formatCurrency(totals.taxable + totals.gst)}</span></div>
                  </div>
                </div>
              )}
            </div>

            {/* Submit */}
            <div className="flex gap-3 pt-4 border-t border-surface-border sticky bottom-0 bg-white pb-2">
              <button type="submit" disabled={isPending}
                className="flex-1 bg-navy-950 text-white py-2 rounded-lg text-sm font-medium hover:bg-navy-800 disabled:opacity-60 inline-flex items-center justify-center gap-2">
                {isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                Create Purchase Order
              </button>
              <button type="button" onClick={() => { setIsOpen(false); setLines([]); }}
                className="px-4 py-2 rounded-lg border border-surface-border text-sm text-ink-muted hover:bg-surface-subtle">
                Cancel
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
