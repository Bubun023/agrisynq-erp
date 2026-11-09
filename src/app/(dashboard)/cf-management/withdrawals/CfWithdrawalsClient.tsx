"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, X, ArrowLeftRight, Trash2 } from "lucide-react";
import { cn, formatDate } from "@/lib/utils";
import { createStockTransfer, dispatchStockTransfer } from "@/actions/logistics";
import { ApproveTransferDialog, ReceiveTransferDialog, type DialogTransfer } from "@/components/logistics/TransferDialogs";
import type { CfStockRow } from "@/actions/cf";

type Item = DialogTransfer["items"][number] & { shortage_qty?: number | null; damaged_qty?: number | null; received_qty?: number | null };
type Withdrawal = Omit<DialogTransfer, "items"> & {
  transfer_date: string;
  status: "DRAFT" | "APPROVED" | "IN_TRANSIT" | "RECEIVED" | "CANCELLED";
  source_location: { name: string } | null;
  destination_location: { name: string } | null;
  cf_agent: { name: string } | null;
  cnf_delivery_order_no?: string | null;
  items: Item[];
};

const STATUS_BADGE: Record<Withdrawal["status"], string> = {
  DRAFT: "badge-warning", APPROVED: "badge-info", IN_TRANSIT: "badge-info", RECEIVED: "badge-success", CANCELLED: "badge-danger",
};
const STATUS_LABEL: Record<Withdrawal["status"], string> = {
  DRAFT: "Awaiting approval", APPROVED: "Approved", IN_TRANSIT: "In transit", RECEIVED: "Received", CANCELLED: "Cancelled",
};
const today = () => new Date().toISOString().slice(0, 10);

type Props = { withdrawals: Withdrawal[]; stock: CfStockRow[]; ownLocations: { id: string; name: string }[] };

export default function CfWithdrawalsClient({ withdrawals, stock, ownLocations }: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [approving, setApproving] = useState<Withdrawal | null>(null);
  const [receiving, setReceiving] = useState<Withdrawal | null>(null);
  const [open, setOpen] = useState(false);

  // new-withdrawal form
  const batchStock = stock.filter((s) => s.batch_id && Number(s.system_qty) > 0);
  const depots = Array.from(new Map(batchStock.map((s) => [s.location_id, s])).values());
  const [f, setF] = useState({ no: "", date: today(), src: "", dst: "", req: "", dno: "", remarks: "" });
  const [lines, setLines] = useState<{ key: string; qty: string }[]>([{ key: "", qty: "" }]);

  const srcRows = batchStock.filter((s) => s.location_id === f.src);
  const rowKey = (s: CfStockRow) => `${s.product_id}|${s.batch_id}`;
  const agentId = srcRows[0]?.cf_agent_id ?? null;

  function begin() {
    setF({ no: `WD-${new Date().getFullYear()}-${Date.now().toString(36).toUpperCase().slice(-5)}`, date: today(), src: "", dst: "", req: "", dno: "", remarks: "" });
    setLines([{ key: "", qty: "" }]);
    setOpen(true);
  }

  const lineProblems = lines.flatMap((l, i) => {
    if (!l.key && !l.qty) return [];
    const row = srcRows.find((s) => rowKey(s) === l.key);
    const q = Number(l.qty);
    if (!row) return [`Line ${i + 1}: choose a product/batch`];
    if (!(q > 0)) return [`Line ${i + 1}: enter a quantity`];
    if (q > Number(row.system_qty)) return [`Line ${i + 1}: only ${Number(row.system_qty)} available at the depot`];
    return [];
  });
  const usable = lines.filter((l) => l.key && Number(l.qty) > 0);
  const canSave = f.src && f.dst && f.req.trim() && f.no.trim() && usable.length > 0 && lineProblems.length === 0;

  function create() {
    start(async () => {
      const res = await createStockTransfer({
        transfer_no: f.no, transfer_date: f.date, transfer_type: "CNF_TO_OWN_WAREHOUSE",
        source_location_id: f.src, destination_location_id: f.dst, cf_agent_id: agentId ?? "",
        cnf_withdrawal_req_no: f.req, cnf_delivery_order_no: f.dno, remarks: f.remarks,
        items: usable.map((l) => {
          const row = srcRows.find((s) => rowKey(s) === l.key)!;
          return { product_id: row.product_id, source_batch_id: row.batch_id!, unit_of_measure: row.unit_of_measure, requested_qty: Number(l.qty), unit_cost: 0 };
        }),
      } as Parameters<typeof createStockTransfer>[0]);
      if (!res.success) { toast.error(res.error ?? "Could not create the withdrawal"); return; }
      toast.success("Withdrawal request created. Approve it with the company's reference to proceed.");
      setOpen(false);
      router.refresh();
    });
  }

  function dispatch(w: Withdrawal) {
    if (!confirm(`Dispatch ${w.transfer_no}? Stock leaves the C&F depot now and is in transit until received.`)) return;
    start(async () => {
      const res = await dispatchStockTransfer(w.id);
      if (!res.success) { toast.error(res.error ?? "Could not dispatch"); return; }
      toast.success(`${w.transfer_no} dispatched.`);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-muted">Request → company approval → dispatch from the C&amp;F depot → receipt at your warehouse.</p>
        <button onClick={begin} className="btn-primary flex items-center gap-2" disabled={depots.length === 0}
          title={depots.length === 0 ? "No stock at C&F locations" : undefined}><Plus className="w-4 h-4" />New withdrawal</button>
      </div>

      <div className="card overflow-x-auto">
        {withdrawals.length === 0 ? (
          <div className="p-12 text-center"><ArrowLeftRight className="w-8 h-8 text-ink-faint mx-auto mb-3" strokeWidth={1.5} />
            <p className="text-ink-muted font-medium">No withdrawals yet</p></div>
        ) : (
          <table className="data-table">
            <thead><tr><th>Transfer</th><th>Date</th><th>From → To</th><th>Request / Approval</th><th>Items</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {withdrawals.map((w) => {
                const lost = w.items.reduce((s, i) => s + Number(i.shortage_qty ?? 0) + Number(i.damaged_qty ?? 0), 0);
                return (
                  <tr key={w.id}>
                    <td className="font-mono text-sm text-leaf-700">{w.transfer_no}</td>
                    <td className="text-sm">{formatDate(w.transfer_date)}</td>
                    <td><div className="text-sm">{w.source_location?.name} → {w.destination_location?.name}</div><div className="text-xs text-ink-faint">{w.cf_agent?.name}</div></td>
                    <td><div className="font-mono text-xs">{w.cnf_withdrawal_req_no ?? "—"}</div>
                      <div className="font-mono text-xs text-ink-faint">{w.cnf_company_approval_ref ?? "not approved"}</div></td>
                    <td className="text-sm">{w.items.map((i) => `${i.product?.name ?? "?"} ×${Number(i.requested_qty)}`).join(", ")}
                      {w.status === "RECEIVED" && lost > 0 && <div className="text-xs text-danger-600">{lost} lost in transit</div>}</td>
                    <td><span className={cn("badge text-2xs", STATUS_BADGE[w.status])}>{STATUS_LABEL[w.status]}</span></td>
                    <td className="text-right whitespace-nowrap">
                      {w.status === "DRAFT" && <button onClick={() => setApproving(w)} className="btn-ghost text-xs">Approve</button>}
                      {w.status === "APPROVED" && <button onClick={() => dispatch(w)} disabled={pending} className="btn-ghost text-xs">Dispatch</button>}
                      {w.status === "IN_TRANSIT" && <button onClick={() => setReceiving(w)} className="btn-ghost text-xs">Receive</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {approving && <ApproveTransferDialog transfer={approving} onClose={() => setApproving(null)} onDone={() => { setApproving(null); router.refresh(); }} />}
      {receiving && <ReceiveTransferDialog transfer={receiving} onClose={() => setReceiving(null)} onDone={() => { setReceiving(null); router.refresh(); }} />}

      {open && (
        <>
          <div className="fixed inset-0 bg-black/50 z-40" onClick={() => setOpen(false)} aria-hidden />
          <div className="fixed right-0 top-0 h-full w-full max-w-xl bg-white z-50 shadow-xl p-6 overflow-y-auto space-y-4">
            <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">New C&amp;F withdrawal</h2>
              <button onClick={() => setOpen(false)} className="p-1.5 hover:bg-surface-border rounded-lg" aria-label="Close"><X className="w-5 h-5" /></button></div>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-ink-muted">Transfer no *<input className="form-input w-full font-mono" value={f.no} onChange={(e) => setF({ ...f, no: e.target.value })} /></label>
              <label className="text-xs text-ink-muted">Date *<input type="date" className="form-input w-full" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></label>
              <label className="text-xs text-ink-muted">Withdraw from (C&amp;F depot) *
                <select className="form-input w-full" value={f.src} onChange={(e) => { setF({ ...f, src: e.target.value }); setLines([{ key: "", qty: "" }]); }}>
                  <option value="">Select…</option>{depots.map((d) => <option key={d.location_id} value={d.location_id}>{d.location_name}{d.cf_agent_name ? ` — ${d.cf_agent_name}` : ""}</option>)}</select></label>
              <label className="text-xs text-ink-muted">Into (your warehouse) *
                <select className="form-input w-full" value={f.dst} onChange={(e) => setF({ ...f, dst: e.target.value })}>
                  <option value="">Select…</option>{ownLocations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
              <label className="text-xs text-ink-muted">Withdrawal request no *<input className="form-input w-full font-mono" value={f.req} onChange={(e) => setF({ ...f, req: e.target.value })} /></label>
              <label className="text-xs text-ink-muted">Delivery order no<input className="form-input w-full font-mono" value={f.dno} onChange={(e) => setF({ ...f, dno: e.target.value })} /></label>
            </div>

            <div className="space-y-2">
              <p className="text-sm font-medium">Items</p>
              {lines.map((l, i) => {
                const row = srcRows.find((s) => rowKey(s) === l.key);
                return (
                  <div key={i} className="flex gap-2 items-center">
                    <select className="form-input flex-1" value={l.key} disabled={!f.src} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}>
                      <option value="">{f.src ? "Select product / batch…" : "Choose a depot first"}</option>
                      {srcRows.map((s) => <option key={rowKey(s)} value={rowKey(s)}>{s.product_name} · {s.batch_number} · {Number(s.system_qty)} avail</option>)}</select>
                    <input type="number" min="0" step="0.001" placeholder="Qty" className="form-input w-24 text-right" value={l.qty}
                      onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
                    <span className="text-xs text-ink-faint w-10">{row?.unit_of_measure}</span>
                    <button onClick={() => setLines(lines.length > 1 ? lines.filter((_, j) => j !== i) : lines)} className="p-1.5 hover:bg-surface-border rounded-lg" aria-label="Remove line"><Trash2 className="w-4 h-4 text-ink-faint" /></button>
                  </div>
                );
              })}
              <button onClick={() => setLines([...lines, { key: "", qty: "" }])} className="btn-ghost text-xs" disabled={!f.src}>+ Add line</button>
              {lineProblems.length > 0 && <ul className="text-sm text-danger-600 list-disc ml-5">{lineProblems.map((p) => <li key={p}>{p}</li>)}</ul>}
            </div>
            <label className="text-xs text-ink-muted block">Remarks<input className="form-input w-full" value={f.remarks} onChange={(e) => setF({ ...f, remarks: e.target.value })} /></label>
            <div className="flex gap-2 pt-1"><button onClick={create} disabled={pending || !canSave} className="btn-primary disabled:opacity-50">{pending ? "Saving…" : "Create request"}</button>
              <button onClick={() => setOpen(false)} className="btn-ghost">Cancel</button></div>
          </div>
        </>
      )}
    </div>
  );
}
