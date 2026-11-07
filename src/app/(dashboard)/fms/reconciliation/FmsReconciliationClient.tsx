"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Plus, X, RefreshCcw } from "lucide-react";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import { runFmsReconciliation, resolveFmsReconciliation } from "@/actions/fms";
import type { FmsReconciliationRow } from "@/actions/fms";

const STATUS_BADGE: Record<string, string> = {
  MATCHED: "badge-success",
  VARIANCE: "badge-danger",
  RESOLVED: "badge-info",
  PENDING: "badge-warning",
};

const monthStart = () => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
};
const today = () => new Date().toISOString().slice(0, 10);

const EMPTY = { period_from: monthStart(), period_to: today(), dealer_id: "", product_code: "", fms_qty: "", fms_txns: "", fms_subsidy: "", remarks: "" };

export default function FmsReconciliationClient({ initialRows }: { initialRows: FmsReconciliationRow[] }) {
  const [rows, setRows] = useState(initialRows);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [resolving, setResolving] = useState<FmsReconciliationRow | null>(null);
  const [resolveNote, setResolveNote] = useState("");
  const [pending, start] = useTransition();

  const set = (k: keyof typeof EMPTY) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    start(async () => {
      const res = await runFmsReconciliation({
        period_from: form.period_from,
        period_to: form.period_to,
        dealer_id: form.dealer_id,
        product_code: form.product_code,
        fms_qty: Number(form.fms_qty || 0),
        fms_txns: Math.round(Number(form.fms_txns || 0)),
        fms_subsidy: Number(form.fms_subsidy || 0),
        remarks: form.remarks,
      });
      if (!res.success || !res.data) { toast.error(res.error ?? "Reconciliation failed"); return; }
      setRows((p) => [res.data!, ...p]);
      setOpen(false);
      setForm(EMPTY);
      if (res.data.reconciliation_status === "MATCHED") toast.success("Matched — FMS and system figures agree.");
      else toast.warning("Variance found. Review it and resolve with a note.");
    });
  }

  function confirmResolve() {
    if (!resolving) return;
    start(async () => {
      const res = await resolveFmsReconciliation(resolving.id, resolveNote);
      if (!res.success || !res.data) { toast.error(res.error ?? "Could not resolve"); return; }
      setRows((p) => p.map((r) => (r.id === resolving.id ? res.data! : r)));
      setResolving(null);
      setResolveNote("");
      toast.success("Marked as resolved.");
    });
  }

  const variance = rows.filter((r) => r.reconciliation_status === "VARIANCE").length;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-muted">
          {variance > 0 ? <span className="text-danger-600 font-medium">{variance} unresolved variance(s)</span> : "No unresolved variances"}
        </p>
        <button onClick={() => setOpen(true)} className="btn-primary flex items-center gap-2"><Plus className="w-4 h-4" />New reconciliation</button>
      </div>

      <div className="card overflow-x-auto">
        {rows.length === 0 ? (
          <div className="p-12 text-center">
            <RefreshCcw className="w-8 h-8 text-ink-faint mx-auto mb-3" strokeWidth={1.5} />
            <p className="text-ink-muted font-medium">No reconciliations yet</p>
            <p className="text-sm text-ink-faint mt-1">Enter the totals shown on the FMS portal for a period; the system compares them with your posted farmer sales.</p>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Date</th><th>Period</th><th>Dealer / Product</th>
                <th className="text-right">Qty (FMS / System)</th>
                <th className="text-right">Txns (FMS / System)</th>
                <th className="text-right">Subsidy (FMS / System)</th>
                <th>Status</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="text-sm">{formatDate(r.reconciliation_date)}</td>
                  <td className="text-sm">{formatDate(r.period_from)} – {formatDate(r.period_to)}</td>
                  <td><div className="text-sm font-mono">{r.fms_dealer_id}</div><div className="text-xs text-ink-faint">{r.fms_product_code ?? "All products"}</div></td>
                  <td className={cn("text-right font-mono text-sm", Number(r.qty_variance) !== 0 && "text-danger-600")}>
                    {Number(r.fms_total_qty)} / {Number(r.system_total_qty)}
                  </td>
                  <td className={cn("text-right font-mono text-sm", r.fms_total_transactions !== r.system_total_transactions && "text-danger-600")}>
                    {r.fms_total_transactions} / {r.system_total_transactions}
                  </td>
                  <td className={cn("text-right font-mono text-sm", Number(r.subsidy_variance) !== 0 && "text-danger-600")}>
                    {formatCurrency(Number(r.fms_total_subsidy))} / {formatCurrency(Number(r.system_total_subsidy))}
                  </td>
                  <td>
                    <span className={cn("badge text-2xs", STATUS_BADGE[r.reconciliation_status])}>{r.reconciliation_status}</span>
                    {r.remarks && <div className="text-xs text-ink-faint mt-1 max-w-[220px] truncate" title={r.remarks}>{r.remarks}</div>}
                  </td>
                  <td className="text-right">
                    {(r.reconciliation_status === "VARIANCE" || r.reconciliation_status === "PENDING") && (
                      <button onClick={() => { setResolving(r); setResolveNote(""); }} className="btn-ghost text-xs">Resolve</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {open && (
        <>
          <div className="fixed inset-0 bg-black/50 z-40" onClick={() => setOpen(false)} aria-hidden />
          <form onSubmit={submit} className="fixed right-0 top-0 h-full w-full max-w-md bg-white z-50 shadow-xl p-6 overflow-y-auto space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">New FMS reconciliation</h2>
              <button type="button" onClick={() => setOpen(false)} className="p-1.5 hover:bg-surface-border rounded-lg" aria-label="Close"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-sm text-ink-muted">Enter the totals from the FMS/iFMS portal. System figures are taken from your POSTED farmer sales for the same dealer, period and product.</p>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-ink-muted">Period from *<input required type="date" className="form-input w-full" value={form.period_from} onChange={set("period_from")} /></label>
              <label className="text-xs text-ink-muted">Period to *<input required type="date" className="form-input w-full" value={form.period_to} onChange={set("period_to")} /></label>
            </div>
            <label className="text-xs text-ink-muted block">FMS dealer ID *<input required className="form-input w-full" value={form.dealer_id} onChange={set("dealer_id")} /></label>
            <label className="text-xs text-ink-muted block">FMS product code (blank = all)<input className="form-input w-full" value={form.product_code} onChange={set("product_code")} /></label>
            <div className="grid grid-cols-3 gap-3">
              <label className="text-xs text-ink-muted">FMS qty *<input required type="number" step="0.001" min="0" className="form-input w-full" value={form.fms_qty} onChange={set("fms_qty")} /></label>
              <label className="text-xs text-ink-muted">FMS txns *<input required type="number" step="1" min="0" className="form-input w-full" value={form.fms_txns} onChange={set("fms_txns")} /></label>
              <label className="text-xs text-ink-muted">FMS subsidy ₹ *<input required type="number" step="0.01" min="0" className="form-input w-full" value={form.fms_subsidy} onChange={set("fms_subsidy")} /></label>
            </div>
            <label className="text-xs text-ink-muted block">Remarks<input className="form-input w-full" value={form.remarks} onChange={set("remarks")} /></label>
            <div className="flex gap-2 pt-2">
              <button type="submit" disabled={pending} className="btn-primary disabled:opacity-50">{pending ? "Comparing…" : "Run reconciliation"}</button>
              <button type="button" onClick={() => setOpen(false)} className="btn-ghost">Cancel</button>
            </div>
          </form>
        </>
      )}

      {resolving && (
        <>
          <div className="fixed inset-0 bg-black/50 z-40" onClick={() => setResolving(null)} aria-hidden />
          <div className="fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-white rounded-xl shadow-xl p-6 space-y-3">
            <h2 className="text-lg font-semibold">Resolve variance</h2>
            <p className="text-sm text-ink-muted">
              Qty variance {Number(resolving.qty_variance)}, subsidy variance {formatCurrency(Number(resolving.subsidy_variance))}.
              Explain how it was resolved — this is kept for audit.
            </p>
            <textarea className="form-input w-full" rows={3} value={resolveNote} onChange={(e) => setResolveNote(e.target.value)} placeholder="e.g. Portal double-counted a reversed bill; corrected on 05-Nov" />
            <div className="flex gap-2 justify-end">
              <button onClick={() => setResolving(null)} className="btn-ghost">Cancel</button>
              <button onClick={confirmResolve} disabled={pending || !resolveNote.trim()} className="btn-primary disabled:opacity-50">Mark resolved</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
