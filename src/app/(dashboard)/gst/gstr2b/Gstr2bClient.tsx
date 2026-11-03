"use client";

import { useState, useTransition, useRef } from "react";
import { Upload, RefreshCw, CheckCircle, XCircle, AlertCircle, FileText } from "lucide-react";
import { importGstr2bJson, runGstr2bReconciliation, getGstr2bItems } from "@/actions/gst";
import { toast } from "sonner";
import type { Gstr2bImport, Gstr2bItem } from "@/actions/gst";

interface Props { initialImports: Gstr2bImport[]; }

const INR = (n: number) =>
  new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

function periodLabel(p: string) {
  const mon = ["","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${mon[parseInt(p.slice(0,2),10)] ?? p.slice(0,2)} ${p.slice(2)}`;
}

const RECON_BADGE: Record<string, string> = {
  MATCHED:          "badge-success",
  MISMATCH:         "badge-danger",
  UNMATCHED:        "badge-warning",
  MISSING_IN_BOOKS: "badge",
};

export default function Gstr2bClient({ initialImports }: Props) {
  const [imports, setImports] = useState(initialImports);
  const [selectedImport, setSelectedImport] = useState<string | null>(null);
  const [items, setItems] = useState<Gstr2bItem[]>([]);
  const [reconFilter, setReconFilter] = useState("ALL");
  const [isPending, startTransition] = useTransition();
  const [showUpload, setShowUpload] = useState(false);

  // Upload form state
  const [returnPeriod, setReturnPeriod] = useState("");
  const [gstin, setGstin] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  async function loadItems(importId: string) {
    setSelectedImport(importId);
    const data = await getGstr2bItems(importId);
    setItems(data);
  }

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (!file || !returnPeriod || !gstin) { toast.error("Fill all fields and select a JSON file"); return; }
    const text = await file.text();
    let json: Record<string, unknown>;
    try { json = JSON.parse(text); } catch { toast.error("Invalid JSON file"); return; }
    startTransition(async () => {
      const res = await importGstr2bJson(returnPeriod, gstin, json);
      if (res.success) {
        toast.success(`GSTR-2B imported — ${res.importId}`);
        setShowUpload(false);
        // Refresh imports list
        window.location.reload();
      } else {
        toast.error(res.error ?? "Import failed");
      }
    });
  }

  async function handleReconcile(importId: string) {
    startTransition(async () => {
      const res = await runGstr2bReconciliation(importId);
      if (res.success) {
        toast.success(`Reconciliation done — Matched: ${res.matched}, Mismatch: ${res.mismatched}, Unmatched: ${res.unmatched}`);
        if (selectedImport === importId) await loadItems(importId);
        // Update import status in list
        setImports(prev => prev.map(i => i.id === importId ? { ...i, status: "RECONCILED" } : i));
      } else {
        toast.error(res.error ?? "Reconciliation failed");
      }
    });
  }

  const filteredItems = reconFilter === "ALL" ? items : items.filter(i => i.recon_status === reconFilter);

  const reconStats = {
    matched:   items.filter(i => i.recon_status === "MATCHED").length,
    mismatch:  items.filter(i => i.recon_status === "MISMATCH").length,
    unmatched: items.filter(i => ["UNMATCHED","MISSING_IN_BOOKS"].includes(i.recon_status)).length,
  };

  return (
    <div className="max-w-screen-xl mx-auto space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">GSTR-2B Reconciliation</h1>
          <p className="page-subtitle">Match portal ITC statement against books of account</p>
        </div>
        <button onClick={() => setShowUpload(true)} className="btn-primary flex items-center gap-2 text-sm">
          <Upload className="w-4 h-4" /> Import GSTR-2B JSON
        </button>
      </div>

      {/* Upload Modal */}
      {showUpload && (
        <>
          <div className="fixed inset-0 bg-black/40 z-40" onClick={() => setShowUpload(false)} />
          <div className="fixed inset-y-0 right-0 w-[440px] bg-white z-50 shadow-2xl flex flex-col">
            <div className="flex items-center justify-between px-6 py-4 border-b border-surface">
              <h2 className="font-semibold text-ink">Import GSTR-2B JSON</h2>
              <button onClick={() => setShowUpload(false)} className="text-ink-muted hover:text-ink text-xl">×</button>
            </div>
            <form onSubmit={handleUpload} className="flex-1 overflow-y-auto p-6 space-y-4">
              <div>
                <label className="form-label">Return Period <span className="text-red-500">*</span></label>
                <input type="month" className="form-input"
                  onChange={e => { const [y,m] = e.target.value.split("-"); setReturnPeriod(`${m}${y}`); }}
                  required />
                <p className="text-xs text-ink-muted mt-1">Select the month of the GSTR-2B statement</p>
              </div>
              <div>
                <label className="form-label">Your GSTIN <span className="text-red-500">*</span></label>
                <input value={gstin} onChange={e => setGstin(e.target.value.toUpperCase())}
                  placeholder="e.g. 07AAACF0000A1Z5" className="form-input font-mono" required />
              </div>
              <div>
                <label className="form-label">GSTR-2B JSON File <span className="text-red-500">*</span></label>
                <input ref={fileRef} type="file" accept=".json" className="form-input" required />
                <p className="text-xs text-ink-muted mt-1">Download from GST Portal → Services → Returns → View GSTR-2B → Download JSON</p>
              </div>
              <div className="pt-4">
                <button type="submit" disabled={isPending} className="btn-primary w-full">
                  {isPending ? "Importing…" : "Import & Parse"}
                </button>
              </div>
            </form>
          </div>
        </>
      )}

      {/* Imports list */}
      <div className="card">
        <div className="px-4 py-3 border-b border-surface font-semibold text-sm bg-surface-subtle">
          Imported GSTR-2B Statements
        </div>
        {imports.length === 0 ? (
          <div className="py-14 text-center text-ink-muted">
            <FileText className="w-10 h-10 mx-auto mb-2 opacity-30" />
            <p>No imports yet. Click "Import GSTR-2B JSON" to begin.</p>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Period</th><th>GSTIN</th><th>Imported</th>
                <th className="text-right">Invoices</th>
                <th className="text-right">ITC (IGST)</th>
                <th className="text-right">ITC (CGST+SGST)</th>
                <th>Status</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {imports.map(i => (
                <tr key={i.id} className={selectedImport === i.id ? "bg-leaf-50" : ""}>
                  <td className="font-medium text-sm">{periodLabel(i.return_period)}</td>
                  <td className="font-mono text-xs text-ink-muted">{i.gstin}</td>
                  <td className="text-sm text-ink-muted">{new Date(i.imported_at).toLocaleDateString("en-IN")}</td>
                  <td className="text-right text-sm">{i.total_invoices}</td>
                  <td className="text-right text-sm">₹{INR(i.total_itc_igst)}</td>
                  <td className="text-right text-sm">₹{INR(i.total_itc_cgst + i.total_itc_sgst)}</td>
                  <td>
                    <span className={i.status === "RECONCILED" ? "badge-success" : "badge-warning"}>
                      {i.status}
                    </span>
                  </td>
                  <td>
                    <div className="flex gap-2">
                      <button onClick={() => loadItems(i.id)} className="btn-secondary text-xs py-1 px-2">
                        View
                      </button>
                      <button onClick={() => handleReconcile(i.id)} disabled={isPending}
                        className="btn-primary text-xs py-1 px-2 flex items-center gap-1">
                        <RefreshCw className="w-3 h-3" />
                        Reconcile
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Items detail */}
      {selectedImport && (
        <div className="card">
          <div className="px-4 py-3 border-b border-surface flex items-center justify-between bg-surface-subtle">
            <span className="font-semibold text-sm">Reconciliation Detail</span>
            <div className="flex gap-4 text-xs">
              <span className="text-green-700 flex items-center gap-1"><CheckCircle className="w-3 h-3"/>Matched: {reconStats.matched}</span>
              <span className="text-red-700 flex items-center gap-1"><XCircle className="w-3 h-3"/>Mismatch: {reconStats.mismatch}</span>
              <span className="text-amber-700 flex items-center gap-1"><AlertCircle className="w-3 h-3"/>Unmatched: {reconStats.unmatched}</span>
            </div>
          </div>
          <div className="px-4 py-2 flex gap-2 flex-wrap border-b border-surface">
            {["ALL","MATCHED","MISMATCH","UNMATCHED","MISSING_IN_BOOKS"].map(f => (
              <button key={f} onClick={() => setReconFilter(f)}
                className={`px-2 py-1 rounded text-xs font-medium border transition-colors ${reconFilter === f ? "bg-navy-800 text-white border-navy-800" : "bg-white text-ink-muted border-surface"}`}>
                {f.replace("_", " ")}
              </button>
            ))}
          </div>
          <div className="overflow-x-auto">
            <table className="data-table text-sm">
              <thead>
                <tr>
                  <th>Supplier GSTIN</th><th>Supplier</th><th>Invoice No</th><th>Date</th>
                  <th className="text-right">Taxable</th>
                  <th className="text-right">IGST</th><th className="text-right">CGST</th><th className="text-right">SGST</th>
                  <th className="text-right">Total ITC</th>
                  <th>ITC</th><th>Status</th><th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.length === 0 ? (
                  <tr><td colSpan={12} className="py-8 text-center text-ink-muted">No items for this filter.</td></tr>
                ) : filteredItems.map(item => (
                  <tr key={item.id}>
                    <td className="font-mono text-xs text-ink-muted">{item.supplier_gstin}</td>
                    <td className="max-w-[120px] truncate">{item.supplier_name ?? "—"}</td>
                    <td className="font-mono text-leaf-700">{item.invoice_number}</td>
                    <td>{item.invoice_date}</td>
                    <td className="text-right">{INR(item.taxable_value)}</td>
                    <td className="text-right text-ink-muted">{INR(item.igst_amount)}</td>
                    <td className="text-right text-ink-muted">{INR(item.cgst_amount)}</td>
                    <td className="text-right text-ink-muted">{INR(item.sgst_amount)}</td>
                    <td className="text-right font-semibold text-leaf-700">{INR(item.total_itc)}</td>
                    <td><span className={item.itc_availability === "YES" ? "badge-success" : "badge-danger"}>{item.itc_availability}</span></td>
                    <td><span className={RECON_BADGE[item.recon_status] ?? "badge"}>{item.recon_status.replace("_"," ")}</span></td>
                    <td className="text-xs text-ink-muted max-w-[160px] truncate">{item.mismatch_notes ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
