"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Search, Plus, X, Package, AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { addBatch, quarantineBatch } from "@/actions/batches";
import { formatDate, daysUntil } from "@/lib/utils";

type Batch = {
  id: string;
  batch_number: string;
  internal_batch_ref: string | null;
  product_id: string;
  products: { name: string; product_code: string | null; unit_of_measure: string } | null;
  supplier_id: string | null;
  parties: { name: string } | null;
  location_id: string;
  locations: { name: string; code: string | null } | null;
  opening_qty: number;
  current_qty: number;
  unit_of_measure: string;
  purchase_rate: number;
  landing_cost_per_unit: number;
  manufacture_date: string | null;
  expiry_date: string | null;
  status: string;
  pos_batch_ref: string | null;
  fms_batch_code: string | null;
  received_at: string;
};

type ExpiringBatch = {
  id: string;
  batch_number: string;
  product_id: string;
  location_id: string;
  current_qty: number;
  expiry_date: string;
  days_remaining: number;
};

const STATUS_BADGE: Record<string, string> = {
  OPEN:       "badge-success",
  CLOSED:     "badge",
  QUARANTINE: "badge-warning",
  EXPIRED:    "badge-danger",
  RECALLED:   "badge-danger",
};

export default function BatchesClient({
  initialBatches,
  expiringBatches,
}: {
  initialBatches: Batch[];
  expiringBatches: ExpiringBatch[];
}) {
  const router = useRouter();
  const [search, setSearch]           = useState("");
  const [statusFilter, setStatus]     = useState<string>("OPEN");
  const [isOpen, setIsOpen]           = useState(false);
  const [isPending, startTransition]  = useTransition();

  const filtered = initialBatches.filter((b) => {
    const q = search.toLowerCase();
    const matchSearch = b.batch_number.toLowerCase().includes(q)
      || (b.products?.name ?? "").toLowerCase().includes(q)
      || (b.products?.product_code ?? "").toLowerCase().includes(q)
      || (b.fms_batch_code ?? "").toLowerCase().includes(q);
    const matchStatus = !statusFilter || b.status === statusFilter;
    return matchSearch && matchStatus;
  });

  const handleFormAction = (formData: FormData) => {
    startTransition(async () => {
      const result = await addBatch({}, formData);
      if (result.success) {
        toast.success("Batch added and stock ledger entry posted.");
        setIsOpen(false);
        router.refresh();
      } else if (result.fieldErrors) {
        const errs = Object.values(result.fieldErrors).flat();
        toast.error(errs[0] ?? "Validation error.");
      } else {
        toast.error(result.error ?? "Failed to add batch.");
      }
    });
  };

  const handleQuarantine = async (id: string, batchNo: string) => {
    const reason = window.prompt(`Quarantine reason for batch ${batchNo}:`);
    if (!reason) return;
    const res = await quarantineBatch(id, reason);
    if (res.success) { toast.success("Batch quarantined."); router.refresh(); }
    else toast.error(res.error ?? "Failed to quarantine batch.");
  };

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Batch Register</h1>
          <p className="page-subtitle">Track every received lot with manufacture date, expiry, and real-time stock</p>
        </div>
        <button className="btn btn-primary inline-flex items-center gap-2" onClick={() => setIsOpen(true)}>
          <Plus className="w-4 h-4" />Add Batch / Opening Stock
        </button>
      </div>

      {/* Expiry alert banner */}
      {expiringBatches.length > 0 && (
        <div className="flex items-start gap-3 px-4 py-3 rounded-lg bg-amber-50 border border-amber-200">
          <AlertTriangle className="w-4 h-4 text-amber-700 mt-0.5 shrink-0" />
          <p className="text-sm text-amber-700">
            <strong>{expiringBatches.length} batch{expiringBatches.length > 1 ? "es" : ""} expiring within 30 days.</strong>{" "}
            {expiringBatches.slice(0, 2).map((b) => `${b.batch_number} (${b.days_remaining}d)`).join(", ")}
            {expiringBatches.length > 2 && ` and ${expiringBatches.length - 2} more.`}
          </p>
        </div>
      )}

      {/* Filters */}
      <div className="flex items-center gap-4 flex-wrap">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search batch no., product, FMS code…"
            className="w-full pl-9 pr-4 py-2 bg-white border border-surface-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-navy-500/20 shadow-sm" />
        </div>
        <div className="flex gap-2">
          {["OPEN","QUARANTINE","EXPIRED","CLOSED",""].map((s) => (
            <button key={s || "ALL"} onClick={() => setStatus(s)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                statusFilter === s ? "bg-navy-950 text-white border-navy-950" : "border-surface-border text-ink-muted hover:bg-surface-subtle"
              }`}>
              {s || "All"}
            </button>
          ))}
        </div>
        <span className="text-sm text-ink-faint">{filtered.length} batch{filtered.length !== 1 ? "es" : ""}</span>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm text-left">
            <thead className="bg-surface-subtle text-ink-muted font-medium border-b border-surface-border">
              <tr>
                <th className="px-4 py-3">Batch No.</th>
                <th className="px-4 py-3">Product</th>
                <th className="px-4 py-3">Location</th>
                <th className="px-4 py-3">Supplier</th>
                <th className="px-4 py-3 text-right">Opening</th>
                <th className="px-4 py-3 text-right">Balance</th>
                <th className="px-4 py-3">Mfg Date</th>
                <th className="px-4 py-3">Expiry</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">FMS Ref.</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border text-ink">
              {filtered.length === 0 ? (
                <tr><td colSpan={11} className="px-4 py-12 text-center">
                  <Package className="w-10 h-10 text-ink-faint mx-auto mb-2" strokeWidth={1.5} />
                  <p className="text-ink-muted text-sm">{search ? "No batches match your search." : "No batches added yet."}</p>
                  {!search && <button onClick={() => setIsOpen(true)} className="mt-3 text-sm text-leaf-600 hover:underline">Add opening stock →</button>}
                </td></tr>
              ) : filtered.map((b) => {
                const daysLeft = daysUntil(b.expiry_date);
                const expiryColor = daysLeft === null ? "" : daysLeft < 0 ? "text-danger-600 font-medium" : daysLeft <= 30 ? "text-gold-700 font-medium" : "text-ink-muted";
                const stockPct = b.opening_qty > 0 ? (b.current_qty / b.opening_qty) * 100 : 0;
                return (
                  <tr key={b.id} className="hover:bg-surface-subtle/50 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs font-semibold">{b.batch_number}</td>
                    <td className="px-4 py-3">
                      <p className="font-medium text-ink text-xs">{b.products?.name ?? "—"}</p>
                      <p className="text-ink-faint text-xs">{b.products?.product_code}</p>
                    </td>
                    <td className="px-4 py-3 text-xs text-ink-muted">{b.locations?.name ?? "—"}</td>
                    <td className="px-4 py-3 text-xs text-ink-muted">{b.parties?.name ?? "—"}</td>
                    <td className="px-4 py-3 text-right text-ink-muted">{b.opening_qty.toLocaleString("en-IN", { maximumFractionDigits: 3 })}</td>
                    <td className="px-4 py-3 text-right">
                      <span className={`font-semibold ${stockPct <= 10 ? "text-danger-600" : stockPct <= 25 ? "text-gold-700" : "text-ink"}`}>
                        {b.current_qty.toLocaleString("en-IN", { maximumFractionDigits: 3 })}
                      </span>
                      <span className="text-ink-faint text-xs ml-1">{b.unit_of_measure}</span>
                    </td>
                    <td className="px-4 py-3 text-xs text-ink-muted whitespace-nowrap">{b.manufacture_date ? formatDate(b.manufacture_date) : "—"}</td>
                    <td className={`px-4 py-3 text-xs whitespace-nowrap ${expiryColor}`}>
                      {b.expiry_date ? `${formatDate(b.expiry_date)}${daysLeft !== null && daysLeft >= 0 && daysLeft <= 90 ? ` (${daysLeft}d)` : ""}` : "—"}
                    </td>
                    <td className="px-4 py-3"><span className={`${STATUS_BADGE[b.status] ?? "badge"} text-xs`}>{b.status}</span></td>
                    <td className="px-4 py-3 text-xs text-ink-muted font-mono">{b.fms_batch_code ?? "—"}</td>
                    <td className="px-4 py-3 text-right">
                      {b.status === "OPEN" && (
                        <button onClick={() => handleQuarantine(b.id, b.batch_number)}
                          className="text-xs text-amber-700 hover:underline px-2 py-1">Quarantine</button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add Batch Slide-over */}
      {isOpen && <div className="fixed inset-0 bg-black/20 z-40" onClick={() => setIsOpen(false)} />}
      <div className={`fixed inset-y-0 right-0 w-[520px] bg-white shadow-xl z-50 flex flex-col transform transition-transform duration-300 ${isOpen ? "translate-x-0" : "translate-x-full"}`}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-border">
          <h2 className="text-base font-semibold text-ink">Add Batch / Opening Stock</h2>
          <button onClick={() => setIsOpen(false)}><X className="w-5 h-5 text-ink-muted" /></button>
        </div>
        <div className="flex-1 overflow-y-auto">
          <form action={handleFormAction} className="px-6 py-4 space-y-4">
            {/* Opening stock toggle */}
            <div className="flex items-center gap-3 p-3 bg-surface-subtle rounded-lg">
              <input type="checkbox" name="is_opening_stock" value="true" id="is_opening" className="rounded" defaultChecked />
              <label htmlFor="is_opening" className="text-sm text-ink">
                <span className="font-medium">Opening Stock Entry</span>
                <span className="block text-xs text-ink-muted">Uncheck for a new GRN (Goods Receipt Note)</span>
              </label>
            </div>

            <div>
              <label className="form-label">Batch Number *</label>
              <input name="batch_number" required placeholder="Supplier batch / lot number"
                className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-500/20" />
            </div>
            <div>
              <label className="form-label">Product ID * <span className="text-ink-faint">(UUID)</span></label>
              <input name="product_id" required placeholder="Product UUID from products table"
                className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-navy-500/20" />
              <p className="text-xs text-ink-faint mt-1">Tip: product UUID selector will be added after Phase 4 purchase flow.</p>
            </div>
            <div>
              <label className="form-label">Location ID * <span className="text-ink-faint">(UUID)</span></label>
              <input name="location_id" required placeholder="Location UUID from locations table"
                className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-navy-500/20" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="form-label">Opening Qty *</label>
                <input type="number" name="opening_qty" required min="0.001" step="0.001" placeholder="0.000"
                  className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-500/20" />
              </div>
              <div>
                <label className="form-label">Unit of Measure *</label>
                <input name="unit_of_measure" required placeholder="e.g. MT, KG, BAG"
                  className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-500/20" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="form-label">Purchase Rate (ex-GST)</label>
                <input type="number" name="purchase_rate" min="0" step="0.01" defaultValue="0"
                  className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-500/20" />
              </div>
              <div>
                <label className="form-label">Landing Cost/Unit</label>
                <input type="number" name="landing_cost_per_unit" min="0" step="0.01" defaultValue="0"
                  className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-500/20" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="form-label">Manufacture Date</label>
                <input type="date" name="manufacture_date"
                  className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-500/20" />
              </div>
              <div>
                <label className="form-label">Expiry Date</label>
                <input type="date" name="expiry_date"
                  className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-500/20" />
              </div>
            </div>
            <div>
              <label className="form-label">FMS / iFMS Batch Code</label>
              <input name="fms_batch_code" placeholder="FMS batch reference"
                className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-500/20" />
            </div>
            <div>
              <label className="form-label">Narration</label>
              <textarea name="narration" rows={2} placeholder="Opening stock narration"
                className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-500/20 resize-none" />
            </div>
            <div className="flex gap-3 pt-4 border-t border-surface-border sticky bottom-0 bg-white pb-2">
              <button type="submit" disabled={isPending}
                className="flex-1 bg-navy-950 text-white py-2 rounded-lg text-sm font-medium hover:bg-navy-800 disabled:opacity-60 transition-colors inline-flex items-center justify-center gap-2">
                {isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                Add Batch & Post to Ledger
              </button>
              <button type="button" onClick={() => setIsOpen(false)}
                className="px-4 py-2 rounded-lg border border-surface-border text-sm text-ink-muted hover:bg-surface-subtle transition-colors">
                Cancel
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
