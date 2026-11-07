"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { X, AlertCircle, Undo2 } from "lucide-react";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import { cancelFarmerSale, reissueFarmerSale } from "@/actions/fms";
import type { FmsLedgerRow } from "@/actions/fms";

type Props = { sales: FmsLedgerRow[]; cancelled: FmsLedgerRow[] };

export default function FmsReissueClient({ sales, cancelled }: Props) {
  const router = useRouter();
  const [target, setTarget] = useState<FmsLedgerRow | null>(null);
  const [reason, setReason] = useState("");
  const [newPos, setNewPos] = useState("");
  const [qty, setQty] = useState("");
  const [price, setPrice] = useState("");
  const [subsidy, setSubsidy] = useState("");
  const [search, setSearch] = useState("");
  const [pending, start] = useTransition();

  const posted = target?.status === "POSTED";

  function open(r: FmsLedgerRow) {
    setTarget(r);
    setReason("");
    setNewPos("");
    setQty(String(Number(r.qty_sold)));
    setPrice(String(Number(r.selling_price_per_unit)));
    setSubsidy(String(Number(r.subsidy_per_unit)));
  }

  function run(reissue: boolean) {
    if (!target) return;
    start(async () => {
      if (reissue) {
        const res = await reissueFarmerSale({
          saleId: target.id,
          reason,
          newPosId: newPos,
          qty: Number(qty),
          sellingPrice: Number(price),
          subsidyPerUnit: Number(subsidy),
        });
        if (!res.success) { toast.error(res.error ?? "Reissue failed"); return; }
        toast.success(`Cancelled ${target.sale_number}; reissued as ${res.newSaleNumber}. Post it from Sales → Memo Sales.`);
      } else {
        const res = await cancelFarmerSale(target.id, reason);
        if (!res.success) { toast.error(res.error ?? "Cancel failed"); return; }
        toast.success(`${target.sale_number} cancelled.`);
      }
      setTarget(null);
      router.refresh();
    });
  }

  const q = search.trim().toLowerCase();
  const list = sales.filter((r) => !q || r.farmer_name.toLowerCase().includes(q) || r.sale_number.toLowerCase().includes(q) || (r.pos_transaction_id ?? "").toLowerCase().includes(q));

  return (
    <div className="space-y-6">
      <div className="border border-gold-200 bg-gold-50 rounded-lg px-4 py-3 text-sm text-gold-800 flex items-start gap-2">
        <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
        <span>
          Cancelling a <strong>posted</strong> sale returns the stock and reverses the accounting entry (dated today). A cancelled sale&apos;s PoS ID can
          never be used again, so a reissue needs a <strong>new PoS transaction ID</strong>. Remember to reverse the original transaction on the
          FMS portal as well.
        </span>
      </div>

      <div className="card">
        <div className="p-4 flex items-center justify-between gap-3 border-b border-surface-border">
          <h2 className="text-sm font-semibold">Sales that can be cancelled</h2>
          <input type="search" className="form-input text-sm w-full sm:w-64" placeholder="Search farmer, sale no, PoS ID…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        <div className="overflow-x-auto">
          {list.length === 0 ? (
            <p className="p-10 text-center text-sm text-ink-muted">No sales available to cancel.</p>
          ) : (
            <table className="data-table">
              <thead><tr><th>Sale No</th><th>Date</th><th>Farmer</th><th>Product</th><th className="text-right">Qty</th><th className="text-right">Subsidy</th><th>PoS ID</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {list.map((r) => (
                  <tr key={r.id}>
                    <td className="font-mono text-sm text-leaf-700">{r.sale_number}</td>
                    <td className="text-sm">{formatDate(r.sale_date)}</td>
                    <td className="text-sm">{r.farmer_name}</td>
                    <td className="text-sm">{r.product_name}</td>
                    <td className="text-right font-mono text-sm">{Number(r.qty_sold)} {r.unit_of_measure}</td>
                    <td className="text-right font-mono text-sm">{formatCurrency(Number(r.total_subsidy_amount))}</td>
                    <td className="font-mono text-xs">{r.pos_transaction_id ?? "—"}</td>
                    <td><span className={cn("badge text-2xs", r.status === "POSTED" ? "badge-success" : "badge-warning")}>{r.status.replace(/_/g, " ")}</span></td>
                    <td className="text-right"><button onClick={() => open(r)} className="btn-ghost text-xs flex items-center gap-1 ml-auto"><Undo2 className="w-3 h-3" />Cancel / Reissue</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="card">
        <div className="p-4 border-b border-surface-border"><h2 className="text-sm font-semibold">Cancellation history</h2></div>
        <div className="overflow-x-auto">
          {cancelled.length === 0 ? (
            <p className="p-10 text-center text-sm text-ink-muted">Nothing cancelled yet.</p>
          ) : (
            <table className="data-table">
              <thead><tr><th>Sale No</th><th>Cancelled</th><th>Farmer</th><th>Burned PoS ID</th><th>Reason</th><th>Reissued as</th></tr></thead>
              <tbody>
                {cancelled.map((r) => (
                  <tr key={r.id}>
                    <td className="font-mono text-sm">{r.sale_number}</td>
                    <td className="text-sm">{r.cancelled_at ? formatDate(r.cancelled_at) : "—"}</td>
                    <td className="text-sm">{r.farmer_name}</td>
                    <td className="font-mono text-xs">{r.pos_transaction_id ?? "—"}</td>
                    <td className="text-sm max-w-[260px] truncate" title={r.cancellation_reason ?? ""}>{r.cancellation_reason}</td>
                    <td className="font-mono text-sm text-leaf-700">{r.reissued_as_number ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {target && (
        <>
          <div className="fixed inset-0 bg-black/50 z-40" onClick={() => setTarget(null)} aria-hidden />
          <div className="fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-lg max-h-[90vh] overflow-y-auto bg-white rounded-xl shadow-xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Cancel {target.sale_number}</h2>
              <button onClick={() => setTarget(null)} className="p-1.5 hover:bg-surface-border rounded-lg" aria-label="Close"><X className="w-5 h-5" /></button>
            </div>
            <p className="text-sm text-ink-muted">
              {target.farmer_name} · {Number(target.qty_sold)} {target.unit_of_measure} of {target.product_name} · PoS {target.pos_transaction_id ?? "none"}
              {posted ? " · stock and accounts will be reversed" : " · not yet posted, so no accounting effect"}
            </p>
            <label className="text-xs text-ink-muted block">Reason for cancelling *
              <textarea className="form-input w-full" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Wrong quantity keyed at the PoS machine" /></label>

            <div className="border-t border-surface-border pt-3 space-y-3">
              <p className="text-sm font-medium">Reissue (optional)</p>
              <label className="text-xs text-ink-muted block">New PoS transaction ID *
                <input className="form-input w-full font-mono" value={newPos} onChange={(e) => setNewPos(e.target.value)} placeholder="Must differ from every earlier PoS ID" /></label>
              <div className="grid grid-cols-3 gap-3">
                <label className="text-xs text-ink-muted">Qty<input type="number" step="0.001" min="0" className="form-input w-full" value={qty} onChange={(e) => setQty(e.target.value)} /></label>
                <label className="text-xs text-ink-muted">Selling price<input type="number" step="0.01" min="0" className="form-input w-full" value={price} onChange={(e) => setPrice(e.target.value)} /></label>
                <label className="text-xs text-ink-muted">Subsidy / unit<input type="number" step="0.01" min="0" className="form-input w-full" value={subsidy} onChange={(e) => setSubsidy(e.target.value)} /></label>
              </div>
              <p className="text-xs text-ink-faint">The replacement is dated today and starts as &quot;PoS recorded&quot;; amounts are recomputed by the system. Post it afterwards to move stock.</p>
            </div>

            <div className="flex flex-wrap gap-2 justify-end pt-2">
              <button onClick={() => setTarget(null)} className="btn-ghost">Close</button>
              <button onClick={() => run(false)} disabled={pending || reason.trim().length < 3} className="btn-ghost text-danger-600 disabled:opacity-50">Cancel only</button>
              <button onClick={() => run(true)} disabled={pending || reason.trim().length < 3 || !newPos.trim()} className="btn-primary disabled:opacity-50">
                {pending ? "Working…" : "Cancel & reissue"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
