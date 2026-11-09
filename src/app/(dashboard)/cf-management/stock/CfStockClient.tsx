"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { X, Boxes, CheckCircle2 } from "lucide-react";
import { cn, formatDate } from "@/lib/utils";
import { recordCfConfirmation } from "@/actions/cf";
import type { CfStockRow, CfConfirmationStatus } from "@/actions/cf";

const STATUS_LABEL: Record<CfConfirmationStatus, string> = {
  NEVER_CONFIRMED: "Never confirmed",
  CONFIRMATION_OVERDUE: "Confirmation overdue",
  CHANGED_SINCE_CONFIRMED: "Changed since confirmed",
  DISCREPANCY: "Discrepancy",
  CONFIRMED: "Confirmed",
};
const STATUS_BADGE: Record<CfConfirmationStatus, string> = {
  NEVER_CONFIRMED: "badge-warning",
  CONFIRMATION_OVERDUE: "badge-danger",
  CHANGED_SINCE_CONFIRMED: "badge-warning",
  DISCREPANCY: "badge-danger",
  CONFIRMED: "badge-success",
};

export default function CfStockClient({ rows }: { rows: CfStockRow[] }) {
  const router = useRouter();
  const [agent, setAgent] = useState("");
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [target, setTarget] = useState<CfStockRow | null>(null);
  const [qty, setQty] = useState("");
  const [ref, setRef] = useState("");
  const [remarks, setRemarks] = useState("");
  const [pending, start] = useTransition();

  const agents = useMemo(() => Array.from(new Set(rows.map((r) => r.cf_agent_name ?? r.location_name))).sort(), [rows]);
  const list = rows.filter((r) =>
    (!agent || (r.cf_agent_name ?? r.location_name) === agent) &&
    (!status || r.confirmation_status === status) &&
    (!search.trim() || `${r.product_name} ${r.batch_number ?? ""} ${r.location_name}`.toLowerCase().includes(search.trim().toLowerCase())));

  const totalQty = list.reduce((s, r) => s + Number(r.system_qty), 0);
  const attention = rows.filter((r) => r.confirmation_status !== "CONFIRMED").length;
  const overdue = rows.filter((r) => r.confirmation_status === "CONFIRMATION_OVERDUE").length;
  const discrepancies = rows.filter((r) => r.confirmation_status === "DISCREPANCY").length;

  function open(r: CfStockRow) {
    setTarget(r); setQty(String(Number(r.system_qty))); setRef(""); setRemarks("");
  }

  const differs = target ? Number(qty) !== Number(target.system_qty) : false;

  function save() {
    if (!target) return;
    start(async () => {
      const res = await recordCfConfirmation({
        locationId: target.location_id, productId: target.product_id, batchId: target.batch_id,
        confirmedQty: Number(qty), reference: ref, remarks,
      });
      if (!res.success) { toast.error(res.error); return; }
      if (res.variance !== 0) toast.warning(`Recorded with a difference of ${res.variance}. Adjust the stock once the cause is known.`);
      else toast.success("Count confirmed — matches the system.");
      setTarget(null);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="stat-card"><p className="stat-label">Units at C&amp;F</p><p className="stat-value">{totalQty.toLocaleString("en-IN", { maximumFractionDigits: 3 })}</p>
          <p className="stat-sub">{list.length} product/batch line(s)</p></div>
        <div className="stat-card"><p className="stat-label">Need attention</p><p className={cn("stat-value", attention > 0 && "text-danger-600")}>{attention}</p></div>
        <div className="stat-card"><p className="stat-label">Confirmation overdue</p><p className={cn("stat-value", overdue > 0 && "text-danger-600")}>{overdue}</p></div>
        <div className="stat-card"><p className="stat-label">Open discrepancies</p><p className={cn("stat-value", discrepancies > 0 && "text-danger-600")}>{discrepancies}</p></div>
      </div>

      <div className="card p-4 flex flex-wrap items-center gap-3">
        <input type="search" className="form-input text-sm w-full sm:w-64" placeholder="Search product, batch, depot…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="form-input text-sm" value={agent} onChange={(e) => setAgent(e.target.value)} aria-label="Agent filter">
          <option value="">All agents / depots</option>{agents.map((a) => <option key={a} value={a}>{a}</option>)}</select>
        <select className="form-input text-sm" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status filter">
          <option value="">All statuses</option>{Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      </div>

      <div className="card overflow-x-auto">
        {list.length === 0 ? (
          <div className="p-12 text-center">
            <Boxes className="w-8 h-8 text-ink-faint mx-auto mb-3" strokeWidth={1.5} />
            <p className="text-ink-muted font-medium">No stock at C&amp;F locations</p>
            <p className="text-sm text-ink-faint mt-1">Stock appears here after a transfer is received at a location of type &quot;C&amp;F depot&quot; or &quot;Third party&quot;.</p>
          </div>
        ) : (
          <table className="data-table">
            <thead><tr><th>Depot / Agent</th><th>Product</th><th>Batch</th><th className="text-right">System qty</th><th className="text-right">Agent confirmed</th><th>Last confirmed</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {list.map((r) => (
                <tr key={`${r.location_id}-${r.product_id}-${r.batch_id ?? "x"}`}>
                  <td><div className="text-sm font-medium">{r.location_name}</div><div className="text-xs text-ink-faint">{r.cf_agent_name ?? <span className="text-danger-600">No agent set on location</span>}</div></td>
                  <td><div className="text-sm">{r.product_name}</div><div className="text-xs text-ink-faint">{r.product_code}</div></td>
                  <td><div className="font-mono text-xs">{r.batch_number ?? "—"}</div>{r.expiry_date && <div className="text-xs text-ink-faint">exp {formatDate(r.expiry_date)}</div>}</td>
                  <td className="text-right font-mono text-sm">{Number(r.system_qty)} {r.unit_of_measure}</td>
                  <td className="text-right font-mono text-sm">{r.qty_confirmed === null ? "—" : Number(r.qty_confirmed)}</td>
                  <td className="text-sm">{r.last_confirmed_date ? formatDate(r.last_confirmed_date) : "—"}
                    {r.next_confirmation_due && <div className="text-xs text-ink-faint">next by {formatDate(r.next_confirmation_due)}</div>}</td>
                  <td><span className={cn("badge text-2xs", STATUS_BADGE[r.confirmation_status])}>{STATUS_LABEL[r.confirmation_status]}</span>
                    {r.discrepancy_noted && r.discrepancy_remarks && <div className="text-xs text-ink-faint mt-1 max-w-[220px] truncate" title={r.discrepancy_remarks}>{r.discrepancy_remarks}</div>}</td>
                  <td className="text-right"><button onClick={() => open(r)} disabled={!r.cf_agent_id} className="btn-ghost text-xs disabled:opacity-40" title={!r.cf_agent_id ? "Set the custodian on this location first" : undefined}>Confirm count</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {target && (
        <>
          <div className="fixed inset-0 bg-black/50 z-40" onClick={() => setTarget(null)} aria-hidden />
          <div className="fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-white rounded-xl shadow-xl p-6 space-y-3">
            <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">Confirm count</h2>
              <button onClick={() => setTarget(null)} className="p-1.5 hover:bg-surface-border rounded-lg" aria-label="Close"><X className="w-5 h-5" /></button></div>
            <p className="text-sm text-ink-muted">{target.product_name}{target.batch_number ? ` · batch ${target.batch_number}` : ""} at {target.location_name} ({target.cf_agent_name}). The system shows <strong>{Number(target.system_qty)} {target.unit_of_measure}</strong>.</p>
            <label className="text-xs text-ink-muted block">Quantity the agent reports *
              <input type="number" min="0" step="0.001" className="form-input w-full" value={qty} onChange={(e) => setQty(e.target.value)} autoFocus /></label>
            <label className="text-xs text-ink-muted block">Agent&apos;s statement / reference
              <input className="form-input w-full" value={ref} onChange={(e) => setRef(e.target.value)} /></label>
            <label className="text-xs text-ink-muted block">Remarks {differs && <span className="text-danger-600">* required — the count differs from the system</span>}
              <input className="form-input w-full" value={remarks} onChange={(e) => setRemarks(e.target.value)} /></label>
            {differs && <p className="text-xs text-ink-faint">This records the difference only. Once the cause is established, correct the stock through Inventory → Adjustments.</p>}
            <div className="flex justify-end gap-2 pt-1"><button onClick={() => setTarget(null)} className="btn-ghost">Cancel</button>
              <button onClick={save} disabled={pending || qty === "" || (differs && !remarks.trim())} className="btn-primary disabled:opacity-50 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4" />{pending ? "Saving…" : "Record confirmation"}</button></div>
          </div>
        </>
      )}
    </div>
  );
}
