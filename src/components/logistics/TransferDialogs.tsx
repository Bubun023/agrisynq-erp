"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { X } from "lucide-react";
import { approveStockTransfer, receiveStockTransfer } from "@/actions/logistics";

export type DialogTransfer = {
  id: string;
  transfer_no: string;
  transfer_type: string;
  cnf_withdrawal_req_no?: string | null;
  cnf_company_approval_ref?: string | null;
  items: {
    id: string;
    unit_of_measure: string;
    requested_qty: number;
    dispatched_qty: number | null;
    product: { name: string } | null;
    batch: { batch_number: string } | null;
  }[];
};

const isCnf = (t: string) => t === "CNF_TO_OWN_WAREHOUSE" || t === "CNF_DIRECT_TO_CUSTOMER";

function Shell({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} aria-hidden />
      <div className="fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-xl max-h-[90vh] overflow-y-auto bg-white rounded-xl shadow-xl p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-surface-border rounded-lg" aria-label="Close"><X className="w-5 h-5" /></button>
        </div>
        {children}
      </div>
    </>
  );
}

/** Approve a DRAFT transfer. C&F withdrawals must carry the company's approval reference. */
export function ApproveTransferDialog({ transfer, onClose, onDone }: { transfer: DialogTransfer; onClose: () => void; onDone: () => void }) {
  const [ref, setRef] = useState(transfer.cnf_company_approval_ref ?? "");
  const [pending, start] = useTransition();
  const needsRef = isCnf(transfer.transfer_type);

  function go() {
    start(async () => {
      const res = await approveStockTransfer(transfer.id, ref);
      if (!res.success) { toast.error(res.error ?? "Could not approve"); return; }
      toast.success(`${transfer.transfer_no} approved.`);
      onDone();
    });
  }

  return (
    <Shell title={`Approve ${transfer.transfer_no}`} onClose={onClose}>
      {needsRef ? (
        <>
          <p className="text-sm text-ink-muted">
            Stock cannot be withdrawn from a C&amp;F agent without the company&apos;s approval. Request no: <strong>{transfer.cnf_withdrawal_req_no || "— (missing)"}</strong>
          </p>
          <label className="text-xs text-ink-muted block">Company approval reference *
            <input className="form-input w-full font-mono" value={ref} onChange={(e) => setRef(e.target.value)} autoFocus /></label>
        </>
      ) : (
        <p className="text-sm text-ink-muted">Approve this transfer so it can be dispatched.</p>
      )}
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="btn-ghost">Cancel</button>
        <button onClick={go} disabled={pending || (needsRef && !ref.trim())} className="btn-primary disabled:opacity-50">{pending ? "Approving…" : "Approve"}</button>
      </div>
    </Shell>
  );
}

/** Receive an IN_TRANSIT transfer, recording what arrived intact, what arrived damaged, and (derived) what is short. */
export function ReceiveTransferDialog({ transfer, onClose, onDone }: { transfer: DialogTransfer; onClose: () => void; onDone: () => void }) {
  const dispatched = (i: DialogTransfer["items"][number]) => Number(i.dispatched_qty ?? i.requested_qty);
  const [rows, setRows] = useState(() =>
    Object.fromEntries(transfer.items.map((i) => [i.id, { received: String(dispatched(i)), damaged: "0" }])));
  const [remarks, setRemarks] = useState("");
  const [pending, start] = useTransition();

  const num = (v: string) => (v.trim() === "" ? NaN : Number(v));
  const problems = transfer.items.flatMap((i) => {
    const r = num(rows[i.id].received), d = num(rows[i.id].damaged);
    const name = `${i.product?.name ?? "Item"} (${i.batch?.batch_number ?? "—"})`;
    if (Number.isNaN(r) || Number.isNaN(d) || r < 0 || d < 0) return [`${name}: enter valid quantities`];
    if (r + d > dispatched(i) + 1e-9) return [`${name}: received + damaged is more than the ${dispatched(i)} dispatched`];
    return [];
  });
  const totalLoss = transfer.items.reduce((s, i) => {
    const r = num(rows[i.id].received), d = num(rows[i.id].damaged);
    return Number.isNaN(r) || Number.isNaN(d) ? s : s + Math.max(0, dispatched(i) - r);
  }, 0);

  function go() {
    start(async () => {
      const lines = transfer.items.map((i) => ({ itemId: i.id, received: Number(rows[i.id].received), damaged: Number(rows[i.id].damaged) }));
      const res = await receiveStockTransfer(transfer.id, lines, remarks);
      if (!res.success) { toast.error(res.error ?? "Could not receive"); return; }
      toast.success(totalLoss > 0 ? `${transfer.transfer_no} received; ${totalLoss} unit(s) written off as transit loss.` : `${transfer.transfer_no} received in full.`);
      onDone();
    });
  }

  return (
    <Shell title={`Receive ${transfer.transfer_no}`} onClose={onClose}>
      <p className="text-sm text-ink-muted">Count what actually arrived. Anything not received intact is written off at cost to Transit Loss.</p>
      <table className="data-table">
        <thead><tr><th>Item</th><th className="text-right">Sent</th><th className="text-right">Received</th><th className="text-right">Damaged</th><th className="text-right">Short</th></tr></thead>
        <tbody>
          {transfer.items.map((i) => {
            const r = num(rows[i.id].received), d = num(rows[i.id].damaged);
            const short = Number.isNaN(r) || Number.isNaN(d) ? "—" : Math.max(0, dispatched(i) - r - d);
            return (
              <tr key={i.id}>
                <td><div className="text-sm">{i.product?.name ?? "—"}</div><div className="text-xs text-ink-faint">{i.batch?.batch_number}</div></td>
                <td className="text-right font-mono text-sm">{dispatched(i)} {i.unit_of_measure}</td>
                <td className="text-right"><input type="number" min="0" step="0.001" className="form-input w-24 text-right" value={rows[i.id].received}
                  onChange={(e) => setRows((p) => ({ ...p, [i.id]: { ...p[i.id], received: e.target.value } }))} /></td>
                <td className="text-right"><input type="number" min="0" step="0.001" className="form-input w-24 text-right" value={rows[i.id].damaged}
                  onChange={(e) => setRows((p) => ({ ...p, [i.id]: { ...p[i.id], damaged: e.target.value } }))} /></td>
                <td className={`text-right font-mono text-sm ${typeof short === "number" && short > 0 ? "text-danger-600" : ""}`}>{short}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <label className="text-xs text-ink-muted block">Remarks (recommended when anything is short or damaged)
        <input className="form-input w-full" value={remarks} onChange={(e) => setRemarks(e.target.value)} /></label>
      {problems.length > 0 && <ul className="text-sm text-danger-600 list-disc ml-5">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="btn-ghost">Cancel</button>
        <button onClick={go} disabled={pending || problems.length > 0} className="btn-primary disabled:opacity-50">{pending ? "Receiving…" : "Confirm receipt"}</button>
      </div>
    </Shell>
  );
}
