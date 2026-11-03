'use client';

import { useState, useTransition } from 'react';
import { createStockAdjustment } from '@/actions/inventory';
import type { StockAdjustment } from '@/actions/inventory';

type Props = {
  initialRows: StockAdjustment[];
  products:    { id: string; product_name: string; product_code: string }[];
  locations:   { id: string; location_name: string }[];
};

const REASONS = [
  { value: 'RECOUNT',      label: 'Physical Recount' },
  { value: 'DAMAGE',       label: 'Damage / Breakage' },
  { value: 'EXPIRY',       label: 'Expiry Write-Off' },
  { value: 'THEFT',        label: 'Theft / Pilferage' },
  { value: 'SAMPLE',       label: 'Sample / Demo' },
  { value: 'TRANSFER_IN',  label: 'Transfer In' },
  { value: 'TRANSFER_OUT', label: 'Transfer Out' },
  { value: 'OTHER',        label: 'Other' },
];

const REASON_COLORS: Record<string, string> = {
  RECOUNT:      'bg-blue-100 text-blue-800',
  DAMAGE:       'bg-red-100 text-red-700',
  EXPIRY:       'bg-orange-100 text-orange-700',
  THEFT:        'bg-red-200 text-red-900',
  SAMPLE:       'bg-purple-100 text-purple-700',
  TRANSFER_IN:  'bg-emerald-100 text-emerald-700',
  TRANSFER_OUT: 'bg-amber-100 text-amber-800',
  OTHER:        'bg-slate-100 text-slate-700',
};

const today = new Date().toISOString().split('T')[0];

export default function StockAdjustmentsClient({ initialRows, products, locations }: Props) {
  const [rows, setRows] = useState<StockAdjustment[]>(initialRows);
  const [showForm, setShowForm] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [error, setError]     = useState('');
  const [success, setSuccess] = useState('');

  // Form state
  const [form, setForm] = useState({
    adjustment_date: today,
    product_id:      '',
    location_id:     '',
    reason:          'RECOUNT',
    qty_adjustment:  '',
    notes:           '',
  });

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setSuccess('');

    const qty = parseFloat(form.qty_adjustment);
    if (!form.product_id) { setError('Select a product.'); return; }
    if (isNaN(qty) || qty === 0) { setError('Qty adjustment cannot be zero.'); return; }

    startTransition(async () => {
      const result = await createStockAdjustment({
        adjustment_date: form.adjustment_date,
        product_id:      form.product_id,
        location_id:     form.location_id || undefined,
        reason:          form.reason,
        qty_adjustment:  qty,
        notes:           form.notes || undefined,
      });

      if (result.error) {
        setError(result.error);
      } else {
        setSuccess(`Adjustment ${result.data?.adjustment_no} created successfully.`);
        setShowForm(false);
        setForm({ adjustment_date: today, product_id: '', location_id: '', reason: 'RECOUNT', qty_adjustment: '', notes: '' });
        // Refresh list by prepending new row
        if (result.data) {
          const newRow = result.data as unknown as StockAdjustment;
          setRows(prev => [newRow, ...prev]);
        }
      }
    });
  }

  return (
    <div className="space-y-4">
      {/* Header actions */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-slate-500">{rows.length} adjustment(s) recorded</p>
        </div>
        <button
          onClick={() => { setShowForm(true); setError(''); setSuccess(''); }}
          className="px-4 py-2 bg-green-700 text-white text-sm font-medium rounded-lg hover:bg-green-800"
        >
          + New Adjustment
        </button>
      </div>

      {/* Success */}
      {success && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm px-4 py-3 rounded-lg">
          ✅ {success}
        </div>
      )}

      {/* New Adjustment Form */}
      {showForm && (
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <h2 className="text-base font-semibold text-slate-800 mb-4">New Stock Adjustment</h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Date *</label>
                <input
                  type="date" name="adjustment_date" value={form.adjustment_date}
                  onChange={handleChange} required
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Product *</label>
                <select
                  name="product_id" value={form.product_id} onChange={handleChange} required
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500"
                >
                  <option value="">— Select Product —</option>
                  {products.map(p => (
                    <option key={p.id} value={p.id}>{p.product_code} — {p.product_name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Location</label>
                <select
                  name="location_id" value={form.location_id} onChange={handleChange}
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500"
                >
                  <option value="">— All Locations —</option>
                  {locations.map(l => (
                    <option key={l.id} value={l.id}>{l.location_name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Reason *</label>
                <select
                  name="reason" value={form.reason} onChange={handleChange} required
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500"
                >
                  {REASONS.map(r => (
                    <option key={r.value} value={r.value}>{r.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">
                  Qty Adjustment * <span className="text-slate-400">(+ increase / – decrease)</span>
                </label>
                <input
                  type="number" name="qty_adjustment" value={form.qty_adjustment}
                  onChange={handleChange} step="0.001" placeholder="e.g. -5.000 or +10.000"
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Notes</label>
                <input
                  type="text" name="notes" value={form.notes} onChange={handleChange}
                  placeholder="Optional remarks…"
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2 rounded-lg">
                ⚠️ {error}
              </div>
            )}

            <div className="flex gap-2">
              <button
                type="submit" disabled={isPending}
                className="px-5 py-2 bg-green-700 text-white text-sm font-medium rounded-lg hover:bg-green-800 disabled:opacity-50"
              >
                {isPending ? 'Saving…' : 'Save Adjustment'}
              </button>
              <button
                type="button" onClick={() => { setShowForm(false); setError(''); }}
                className="px-5 py-2 bg-slate-100 text-slate-700 text-sm rounded-lg hover:bg-slate-200"
              >
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Adjustments Table */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Adj No</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Date</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Product</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Batch</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Location</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Reason</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-slate-600">Before</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-slate-600">Adjustment</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-slate-600">After</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-4 py-12 text-center text-slate-400">
                    No adjustments recorded yet
                  </td>
                </tr>
              ) : (
                rows.map(r => (
                  <tr key={r.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-mono text-xs text-slate-700">{r.adjustment_no}</td>
                    <td className="px-4 py-3 text-slate-600">{r.adjustment_date}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-800">{r.products?.product_name}</div>
                      <div className="text-xs text-slate-400">{r.products?.product_code}</div>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">{r.inventory_batches?.batch_no ?? '—'}</td>
                    <td className="px-4 py-3 text-xs text-slate-500">{r.locations?.location_name ?? '—'}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${REASON_COLORS[r.reason] ?? 'bg-slate-100 text-slate-700'}`}>
                        {REASONS.find(x => x.value === r.reason)?.label ?? r.reason}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-slate-600">{Number(r.qty_before).toFixed(3)}</td>
                    <td className={`px-4 py-3 text-right font-semibold ${Number(r.qty_adjustment) >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                      {Number(r.qty_adjustment) >= 0 ? '+' : ''}{Number(r.qty_adjustment).toFixed(3)}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-slate-900">{Number(r.qty_after).toFixed(3)}</td>
                    <td className="px-4 py-3 text-xs text-slate-400">{r.notes ?? '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
