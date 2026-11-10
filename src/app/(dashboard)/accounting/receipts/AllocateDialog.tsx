'use client';

import { useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { X } from 'lucide-react';
import { formatCurrency, formatDate } from '@/lib/utils';
import { getReceiptAllocationInfo, saveReceiptAllocations, type AllocInfo } from '@/actions/receipt-allocations';

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Choose which invoices a draft receipt / payment settles. Leave everything blank to settle oldest-first when posting. */
export default function AllocateDialog({ receiptId, onClose, onSaved }: { receiptId: string; onClose: () => void; onSaved: (allocated: number) => void }) {
  const [info, setInfo] = useState<AllocInfo | null>(null);
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [pending, start] = useTransition();

  useEffect(() => {
    getReceiptAllocationInfo(receiptId).then((i) => {
      setInfo(i);
      setAmounts(Object.fromEntries(i.invoices.filter((x) => x.allocated > 0).map((x) => [x.id, String(x.allocated)])));
    });
  }, [receiptId]);

  const total = r2(Object.values(amounts).reduce((s, v) => s + (Number(v) || 0), 0));
  const receiptAmount = info?.receipt?.amount ?? 0;
  const left = r2(receiptAmount - total);

  function fillOldestFirst() {
    if (!info) return;
    let remaining = receiptAmount;
    const next: Record<string, string> = {};
    for (const inv of info.invoices) {
      if (remaining <= 0) break;
      const take = r2(Math.min(remaining, inv.outstanding));
      next[inv.id] = String(take);
      remaining = r2(remaining - take);
    }
    setAmounts(next);
  }

  function save() {
    start(async () => {
      const rows = Object.entries(amounts).map(([invoiceId, v]) => ({ invoiceId, amount: Number(v) || 0 }));
      const r = await saveReceiptAllocations(receiptId, rows);
      if (r.error) { toast.error(r.error); return; }
      toast.success(rows.some((x) => x.amount > 0) ? 'Allocation saved.' : 'Allocation cleared - will settle oldest-first on posting.');
      onSaved(total);
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b px-5 py-3">
          <div>
            <div className="font-semibold">Allocate {info?.receipt?.receipt_no ?? ''}</div>
            {info?.receipt && <div className="text-xs text-slate-500">{info.receipt.party_name} · {info.receipt.type === 'RECEIPT' ? 'received' : 'paid'} {formatCurrency(receiptAmount)}</div>}
          </div>
          <button onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        <div className="space-y-3 p-5">
          {!info && <div className="text-sm text-slate-500">Loading…</div>}
          {info?.error && <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">{info.error}</div>}
          {info && !info.error && (
            <>
              {info.invoices.length === 0 ? (
                <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">This party has no open invoices. The amount will stay on their account as an advance.</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-left text-slate-500"><tr><th className="py-1">Invoice</th><th>Date</th><th>Due</th><th className="text-right">Outstanding</th><th className="text-right">Settle now</th></tr></thead>
                  <tbody>
                    {info.invoices.map((i) => (
                      <tr key={i.id} className="border-t">
                        <td className="py-1.5 font-mono text-xs">{i.invoice_number}</td>
                        <td>{formatDate(i.invoice_date)}</td>
                        <td>{i.due_date ? formatDate(i.due_date) : '—'}</td>
                        <td className="text-right font-mono">{formatCurrency(i.outstanding)}</td>
                        <td className="text-right">
                          <input type="number" min={0} max={i.outstanding} step="0.01" value={amounts[i.id] ?? ''} placeholder="0"
                            onChange={(e) => setAmounts((a) => ({ ...a, [i.id]: e.target.value }))}
                            className="w-28 rounded border border-slate-300 px-2 py-1 text-right font-mono" />
                          <button type="button" className="ml-1 text-xs text-emerald-700 underline"
                            onClick={() => setAmounts((a) => ({ ...a, [i.id]: String(Math.min(i.outstanding, r2(receiptAmount - (total - (Number(a[i.id]) || 0))))) }))}>max</button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="flex flex-wrap items-center justify-between gap-2 rounded bg-slate-50 p-3 text-sm">
                <span>Allocated <b>{formatCurrency(total)}</b> of {formatCurrency(receiptAmount)}</span>
                <span className={left < 0 ? 'font-semibold text-red-600' : 'text-slate-600'}>
                  {left < 0 ? `Over by ${formatCurrency(-left)}` : left > 0 ? `${formatCurrency(left)} will stay on account as an advance` : 'Fully allocated'}
                </span>
              </div>
              <p className="text-xs text-slate-500">If you save nothing, posting settles the oldest invoices first automatically.</p>
            </>
          )}
        </div>

        <div className="flex justify-between gap-2 border-t px-5 py-3">
          <button className="text-sm text-slate-600 underline" onClick={fillOldestFirst} disabled={!info || !!info.error}>Fill oldest first</button>
          <div className="flex gap-2">
            <button className="rounded border border-slate-300 px-4 py-2 text-sm" onClick={onClose}>Cancel</button>
            <button className="btn-primary px-4 py-2 text-sm disabled:opacity-50" disabled={pending || left < 0 || !info || !!info.error} onClick={save}>{pending ? 'Saving…' : 'Save allocation'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
