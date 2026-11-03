'use client';

import { useState } from 'react';
import type { StockLedgerRow } from '@/actions/inventory';

type Props = {
  initialRows:  StockLedgerRow[];
  products:     { id: string; product_name: string; product_code: string }[];
  locations:    { id: string; location_name: string }[];
};

const TXN_TYPE_LABELS: Record<string, string> = {
  GRN:         'GRN Receipt',
  SALE:        'Sale Issue',
  CREDIT_NOTE: 'Credit Note Return',
  ADJUSTMENT:  'Adjustment',
  TRANSFER_IN: 'Transfer In',
  TRANSFER_OUT:'Transfer Out',
};

const TXN_TYPE_COLORS: Record<string, string> = {
  GRN:          'bg-emerald-100 text-emerald-800',
  SALE:         'bg-red-100 text-red-700',
  CREDIT_NOTE:  'bg-blue-100 text-blue-800',
  ADJUSTMENT:   'bg-amber-100 text-amber-800',
  TRANSFER_IN:  'bg-teal-100 text-teal-800',
  TRANSFER_OUT: 'bg-orange-100 text-orange-800',
};

export default function StockLedgerClient({ initialRows, products, locations }: Props) {
  const [rows]                      = useState<StockLedgerRow[]>(initialRows);
  const [productId, setProductId]   = useState('');
  const [locationId, setLocationId] = useState('');
  const [txnType, setTxnType]       = useState('');
  const [fromDate, setFromDate]     = useState('');
  const [toDate, setToDate]         = useState('');

  // Client-side filter (server-fetched on mount, refetch on apply)
  const displayed = rows.filter(r => {
    const matchProduct  = !productId  || r.product_id === productId;
    const matchLocation = !locationId || r.location_id === locationId;
    const matchType     = !txnType    || r.txn_type === txnType;
    const matchFrom     = !fromDate   || r.txn_date >= fromDate;
    const matchTo       = !toDate     || r.txn_date <= toDate;
    return matchProduct && matchLocation && matchType && matchFrom && matchTo;
  });

  const totalIn  = displayed.reduce((s, r) => s + Number(r.qty_in), 0);
  const totalOut = displayed.reduce((s, r) => s + Number(r.qty_out), 0);
  const closing  = displayed.length > 0 ? Number(displayed[0].running_balance) : 0;

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Product</label>
            <select value={productId} onChange={e => setProductId(e.target.value)}
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500">
              <option value="">All Products</option>
              {products.map(p => (
                <option key={p.id} value={p.id}>{p.product_code} — {p.product_name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Location</label>
            <select value={locationId} onChange={e => setLocationId(e.target.value)}
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500">
              <option value="">All Locations</option>
              {locations.map(l => (
                <option key={l.id} value={l.id}>{l.location_name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Type</label>
            <select value={txnType} onChange={e => setTxnType(e.target.value)}
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500">
              <option value="">All Types</option>
              {Object.entries(TXN_TYPE_LABELS).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">From Date</label>
            <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500" />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">To Date</label>
            <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500" />
          </div>
        </div>
        <button onClick={() => { setProductId(''); setLocationId(''); setTxnType(''); setFromDate(''); setToDate(''); }}
          className="mt-3 px-4 py-1.5 text-xs bg-slate-100 text-slate-600 rounded-lg hover:bg-slate-200">
          Reset Filters
        </button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Total In',        value: totalIn.toFixed(3),  color: 'text-emerald-700', bg: 'bg-emerald-50' },
          { label: 'Total Out',       value: totalOut.toFixed(3), color: 'text-red-700',     bg: 'bg-red-50' },
          { label: 'Closing Balance', value: closing.toFixed(3),  color: 'text-slate-900',   bg: 'bg-amber-50' },
        ].map(k => (
          <div key={k.label} className={`${k.bg} rounded-xl border border-slate-200 p-4`}>
            <p className="text-xs text-slate-500 mb-1">{k.label}</p>
            <p className={`text-2xl font-bold ${k.color}`}>{k.value}</p>
          </div>
        ))}
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
          <span className="text-sm font-semibold text-slate-700">Stock Ledger</span>
          <span className="text-xs text-slate-400">{displayed.length} rows</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Date</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Type</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Reference</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Product</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Batch</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Location</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-slate-600">In</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-slate-600">Out</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-slate-600">Balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {displayed.length === 0 ? (
                <tr><td colSpan={9} className="px-4 py-12 text-center text-slate-400">No transactions found</td></tr>
              ) : (
                displayed.map((r, i) => (
                  <tr key={`${r.txn_id}-${i}`} className="hover:bg-slate-50">
                    <td className="px-4 py-3 text-slate-600 whitespace-nowrap">{r.txn_date}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${TXN_TYPE_COLORS[r.txn_type] ?? 'bg-slate-100 text-slate-700'}`}>
                        {TXN_TYPE_LABELS[r.txn_type] ?? r.txn_type}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-700">{r.txn_ref}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-800">{r.product_name}</div>
                      <div className="text-xs text-slate-400">{r.product_code}</div>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">{r.batch_no ?? '—'}</td>
                    <td className="px-4 py-3 text-xs text-slate-500">{r.location_name ?? '—'}</td>
                    <td className="px-4 py-3 text-right text-emerald-700 font-medium">
                      {Number(r.qty_in) > 0 ? Number(r.qty_in).toFixed(3) : '—'}
                    </td>
                    <td className="px-4 py-3 text-right text-red-600 font-medium">
                      {Number(r.qty_out) > 0 ? Number(r.qty_out).toFixed(3) : '—'}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-slate-900">
                      {Number(r.running_balance).toFixed(3)}
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
