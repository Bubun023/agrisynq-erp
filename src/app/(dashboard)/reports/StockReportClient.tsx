'use client';

import { useState } from 'react';
import type { StockSummaryReportRow } from '@/actions/reports';

type Props = { rows: StockSummaryReportRow[] };

function fmt(n: number) {
  return Number(n).toFixed(3);
}

export default function StockReportClient({ rows }: Props) {
  const [search, setSearch] = useState('');
  const [showZero, setShowZero] = useState(false);

  const filtered = rows.filter(r => {
    const matchSearch = !search ||
      r.product_name.toLowerCase().includes(search.toLowerCase()) ||
      r.product_code.toLowerCase().includes(search.toLowerCase());
    const matchZero = showZero || Number(r.qty_on_hand) > 0;
    return matchSearch && matchZero;
  });

  const totalProducts  = new Set(filtered.map(r => r.product_id)).size;
  const zeroStockCount = rows.filter(r => Number(r.qty_on_hand) <= 0).length;

  return (
    <div className="space-y-4">
      {/* Alerts */}
      {zeroStockCount > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-center gap-3 text-sm">
          <span className="text-xl">⚠️</span>
          <span className="text-amber-800"><strong>{zeroStockCount}</strong> product(s) have zero or negative stock.</span>
          <button onClick={() => setShowZero(true)} className="ml-auto text-amber-700 underline text-xs">Show them</button>
        </div>
      )}

      {/* Filters */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 flex items-center gap-3">
        <div className="flex-1">
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search product name or code..."
            className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500" />
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600 cursor-pointer">
          <input type="checkbox" checked={showZero} onChange={e => setShowZero(e.target.checked)}
            className="rounded" />
          Show zero/negative stock
        </label>
        <span className="text-xs text-slate-400">{filtered.length} rows</span>
      </div>

      {/* KPI */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Products with Stock', value: totalProducts, color: 'text-slate-900', bg: 'bg-white' },
          { label: 'Zero / Negative',     value: zeroStockCount, color: 'text-red-600', bg: 'bg-red-50' },
          { label: 'Showing Rows',        value: filtered.length, color: 'text-slate-700', bg: 'bg-slate-50' },
        ].map(k => (
          <div key={k.label} className={`${k.bg} rounded-xl border border-slate-200 p-4`}>
            <p className="text-xs text-slate-500 mb-1">{k.label}</p>
            <p className={`text-3xl font-bold ${k.color}`}>{k.value}</p>
          </div>
        ))}
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Code</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Product</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">HSN</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Location</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-slate-600">Qty on Hand</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.length === 0 ? (
                <tr><td colSpan={5} className="px-4 py-12 text-center text-slate-400">No stock found</td></tr>
              ) : (
                filtered.map((r, i) => (
                  <tr key={`${r.product_id}-${i}`} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-mono text-xs text-slate-500">{r.product_code}</td>
                    <td className="px-4 py-3 font-medium text-slate-800">{r.product_name}</td>
                    <td className="px-4 py-3 text-xs text-slate-500">{r.hsn_sac_code ?? '—'}</td>
                    <td className="px-4 py-3 text-sm text-slate-500">{r.location_name ?? 'All Locations'}</td>
                    <td className={`px-4 py-3 text-right font-bold ${Number(r.qty_on_hand) <= 0 ? 'text-red-600' : 'text-slate-900'}`}>
                      {fmt(Number(r.qty_on_hand))}
                    </td>
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
