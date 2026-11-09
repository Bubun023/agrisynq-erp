"use client";

import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { X, Plus, Trash2, ArrowRightLeft } from "lucide-react";
import { formatCurrency } from "@/lib/utils";
import { journalOutValue, journalInUnitCost } from "@/lib/memo";
import { createStockJournal } from "@/actions/stock-journals";
import type { JournalStockBatch } from "@/actions/stock-journals";

export type JournalLookups = {
  locations: { id: string; name: string }[];
  products: { id: string; name: string; product_code: string | null }[];
  stock: JournalStockBatch[];
};

export type JournalPrefill = {
  locationId?: string;
  reason?: string;
  out?: { batchId: string; qty: number }[];
  in?: { productId: string; qty: number }[];
  memoSettlementId?: string;
  purchaseInvoiceId?: string;
};

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Value-preserving stock journal: stock OUT of existing batches, stock IN of other products. The value that goes
 * out is carried onto the incoming batches, so the Stock account does not change. Typical use: the supplier
 * billed product B but physically delivered product A - take B out, bring A in.
 */
export default function StockJournalDialog({ lookups, prefill, onClose, onDone }: {
  lookups: JournalLookups; prefill?: JournalPrefill; onClose: () => void; onDone: (journalNo: string) => void;
}) {
  const [date, setDate] = useState(today());
  const [locationId, setLocationId] = useState(prefill?.locationId ?? "");
  const [reason, setReason] = useState(prefill?.reason ?? "");
  const [outLines, setOutLines] = useState<{ batchId: string; qty: string }[]>(
    prefill?.out?.length ? prefill.out.map((o) => ({ batchId: o.batchId, qty: String(o.qty) })) : [{ batchId: "", qty: "" }]);
  const [inLines, setInLines] = useState<{ productId: string; qty: string; batchNumber: string; expiryDate: string }[]>(
    prefill?.in?.length ? prefill.in.map((i) => ({ productId: i.productId, qty: String(i.qty), batchNumber: "", expiryDate: "" }))
      : [{ productId: "", qty: "", batchNumber: "", expiryDate: "" }]);
  const [pending, start] = useTransition();

  const batchesHere = useMemo(() => lookups.stock.filter((s) => s.location_id === locationId), [lookups.stock, locationId]);
  const byId = useMemo(() => new Map(lookups.stock.map((s) => [`${s.batch_id}|${s.location_id}`, s])), [lookups.stock]);

  const outPreview = outLines.map((l) => {
    const b = byId.get(`${l.batchId}|${locationId}`);
    return { qty: Number(l.qty) || 0, unitCost: b?.unit_cost ?? 0, available: b?.qty ?? 0 };
  });
  const outValue = journalOutValue(outPreview);
  const inQty = inLines.reduce((s, l) => s + (Number(l.qty) || 0), 0);
  const unitCost = journalInUnitCost(outValue, inQty);

  const problems: string[] = [];
  if (!locationId) problems.push("Select the location");
  outLines.forEach((l, i) => {
    if (!l.batchId) problems.push(`Out line ${i + 1}: select a batch`);
    else if (!(Number(l.qty) > 0)) problems.push(`Out line ${i + 1}: enter a quantity`);
    else if (Number(l.qty) > outPreview[i].available + 1e-9) problems.push(`Out line ${i + 1}: only ${outPreview[i].available} available`);
  });
  inLines.forEach((l, i) => {
    if (!l.productId) problems.push(`In line ${i + 1}: select a product`);
    else if (!(Number(l.qty) > 0)) problems.push(`In line ${i + 1}: enter a quantity`);
  });
  if (reason.trim().length < 3) problems.push("Give a reason");

  function save() {
    start(async () => {
      const res = await createStockJournal({
        date, locationId, reason,
        out: outLines.map((l) => ({ batchId: l.batchId, qty: Number(l.qty) })),
        in: inLines.map((l) => ({ productId: l.productId, qty: Number(l.qty), batchNumber: l.batchNumber, expiryDate: l.expiryDate })),
        memoSettlementId: prefill?.memoSettlementId, purchaseInvoiceId: prefill?.purchaseInvoiceId,
      });
      if (!res.success) { toast.error(res.error); return; }
      toast.success(`Stock journal ${res.journalNo} posted.`);
      onDone(res.journalNo);
    });
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} aria-hidden />
      <div className="fixed right-0 top-0 h-full w-full max-w-2xl bg-white z-50 shadow-xl p-6 overflow-y-auto space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold flex items-center gap-2"><ArrowRightLeft className="w-5 h-5" />Stock journal</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-surface-border rounded-lg" aria-label="Close"><X className="w-5 h-5" /></button>
        </div>
        <p className="text-sm text-ink-muted">Moves stock between products without changing the value of your stock: what goes out is carried onto what comes in.</p>

        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs text-ink-muted">Date *<input type="date" max={today()} className="form-input w-full" value={date} onChange={(e) => setDate(e.target.value)} /></label>
          <label className="text-xs text-ink-muted">Location *
            <select className="form-input w-full" value={locationId} onChange={(e) => { setLocationId(e.target.value); setOutLines([{ batchId: "", qty: "" }]); }}>
              <option value="">Select…</option>{lookups.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
        </div>
        <label className="text-xs text-ink-muted block">Reason *
          <input className="form-input w-full" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Billed as B against physical A (invoice / memo no.)" /></label>

        <div className="space-y-2">
          <p className="text-sm font-medium text-danger-600">Stock OUT</p>
          {outLines.map((l, i) => (
            <div key={i} className="flex gap-2 items-center">
              <select className="form-input flex-1" value={l.batchId} disabled={!locationId}
                onChange={(e) => setOutLines(outLines.map((x, j) => (j === i ? { ...x, batchId: e.target.value } : x)))}>
                <option value="">{locationId ? "Select product / batch…" : "Choose the location first"}</option>
                {batchesHere.map((b) => <option key={b.batch_id} value={b.batch_id}>{b.product_name} · {b.batch_number} · {b.qty} avail @ {b.unit_cost}</option>)}</select>
              <input type="number" min="0" step="0.001" placeholder="Qty" className="form-input w-24 text-right" value={l.qty}
                onChange={(e) => setOutLines(outLines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
              <button onClick={() => setOutLines(outLines.length > 1 ? outLines.filter((_, j) => j !== i) : outLines)} className="p-1.5 hover:bg-surface-border rounded-lg" aria-label="Remove line"><Trash2 className="w-4 h-4 text-ink-faint" /></button>
            </div>
          ))}
          <button onClick={() => setOutLines([...outLines, { batchId: "", qty: "" }])} className="btn-ghost text-xs flex items-center gap-1"><Plus className="w-3 h-3" />Add line</button>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-medium text-leaf-700">Stock IN</p>
          {inLines.map((l, i) => (
            <div key={i} className="grid grid-cols-12 gap-2 items-center">
              <select className="form-input col-span-5" value={l.productId} onChange={(e) => setInLines(inLines.map((x, j) => (j === i ? { ...x, productId: e.target.value } : x)))}>
                <option value="">Select product…</option>{lookups.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
              <input type="number" min="0" step="0.001" placeholder="Qty" className="form-input col-span-2 text-right" value={l.qty}
                onChange={(e) => setInLines(inLines.map((x, j) => (j === i ? { ...x, qty: e.target.value } : x)))} />
              <input placeholder="Batch no (auto)" className="form-input col-span-2 text-xs" value={l.batchNumber}
                onChange={(e) => setInLines(inLines.map((x, j) => (j === i ? { ...x, batchNumber: e.target.value } : x)))} />
              <input type="date" title="Expiry" className="form-input col-span-2 text-xs" value={l.expiryDate}
                onChange={(e) => setInLines(inLines.map((x, j) => (j === i ? { ...x, expiryDate: e.target.value } : x)))} />
              <button onClick={() => setInLines(inLines.length > 1 ? inLines.filter((_, j) => j !== i) : inLines)} className="p-1.5 hover:bg-surface-border rounded-lg" aria-label="Remove line"><Trash2 className="w-4 h-4 text-ink-faint" /></button>
            </div>
          ))}
          <button onClick={() => setInLines([...inLines, { productId: "", qty: "", batchNumber: "", expiryDate: "" }])} className="btn-ghost text-xs flex items-center gap-1"><Plus className="w-3 h-3" />Add line</button>
        </div>

        <div className="border border-surface-border rounded-lg p-3 bg-surface-subtle text-sm space-y-1">
          <div className="flex justify-between"><span>Value going out</span><strong>{formatCurrency(outValue)}</strong></div>
          <div className="flex justify-between"><span>Quantity coming in</span><strong>{inQty}</strong></div>
          <div className="flex justify-between"><span>Cost per unit of the incoming stock</span><strong>{formatCurrency(unitCost)}</strong></div>
          <p className="text-xs text-ink-faint pt-1">The Stock account balance is unchanged; only the product and batch cost move.</p>
        </div>

        {problems.length > 0 && <ul className="text-sm text-danger-600 list-disc ml-5">{problems.slice(0, 5).map((p) => <li key={p}>{p}</li>)}</ul>}
        <div className="flex gap-2 pt-1">
          <button onClick={save} disabled={pending || problems.length > 0} className="btn-primary disabled:opacity-50">{pending ? "Posting…" : "Post stock journal"}</button>
          <button onClick={onClose} className="btn-ghost">Cancel</button>
        </div>
      </div>
    </>
  );
}
