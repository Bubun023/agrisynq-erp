'use client';

import { useState } from 'react';
import type { BatchRegisterRow } from '@/actions/inventory';

type Props = {
  initialRows: BatchRegisterRow[];
  products:    { id: string; product_name: string; product_code: string }[];
};

const EXPIRY_BADGE: Record<string, { label: string; cls: string }> = {
  NO_EXPIRY:     { label: 'No Expiry',     cls: 'bg-slate-100 text-slate-600' },
  VALID:         { label: 'Valid',         cls: 'bg-emerald-100 text-emerald-700' },
  EXPIRING_SOON: { label: 'Expiring Soon', cls: 'bg-amber-100 text-amber-700' },
  EXPIRED:       { label: 'Expired',       cls: 'bg-red-100 text-red-700' },
};

export default function BatchRegisterClient({ initialRows, products }: Props) {
  const [rows]                    = useState<BatchRegisterRow[]>(initialRows);
  const [productId, setProductId] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch]       = useState('');

  const filtered = rows.filter(r => {
    const matchProduct = !productId  || r.product_id === productId;
    const matchStatus  = !statusFilter || r.expiry_status === statusFilter;
    const matchSearch  = !search ||
      r.batch_no.toLowerCase().includes(search.toLowerCase()) ||
      r.product_name.toLowerCase().includes(search.toLowerCase()) ||
      r.product_code.toLowerCase().includes(search.toLowerCase());
    return matchProduct && matchStatus && matchSearch;
  });

  const expiredCount = rows.filter(r => r.expiry_status === 'EXPIRED').length;
  const soonCount    = rows.filter(r => r.expiry_status === 'EXPIRING_SOON').length;
  const totalBatches = rows.length;

  return (
    <div className="space-y-4">
      {/* Alert banner */}
      {(expiredCount > 0 || soonCount > 0) && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
          <span className="text-2xl">⚠️</span>
          <div>
            <p className="font-semibold text-amber-900">Stock Alerts</p>
            <p className="text-sm text-amber-700">
              {expiredCount > 0 && <span className="mr-3">{expiredCount} batch(es) <strong>EXPIRED</strong></span>}
              {soonCount > 0 && <span>{soonCount} batch(es) expiring within 90 days</span>}
            </p>
          </div>
        </div>
      )}

      {/* KPI row */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: 'Total Batches', value: totalBatches, color: 'text-slate-900', bg: 'bg-white' },
          { label: 'Valid',         value: rows.filter(r => r.expiry_status === 'VALID').length,         color: 'text-emerald-700', bg: 'bg-emerald-50' },
          { label: 'Expiring Soon', value: soonCount,    color: 'text-amber-700', bg: 'bg-amber-50' },
          { label: 'Expired',       value: expiredCount, color: 'text-red-700',   bg: 'bg-red-50' },
        ].map(k => (
          <div key={k.label} className={`${k.bg} rounded-xl border border-slate-200 p-4`}>
            <p className="text-xs text-slate-500 mb-1">{k.label}</p>
            <p className={`text-3xl font-bold ${k.color}`}>{k.value}</p>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Search batch / product</label>
            <input
              type="text" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Batch no, product name…"
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Product</label>
            <select
              value={productId} onChange={e => setProductId(e.target.value)}
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500"
            >
              <option value="">All Products</option>
              {products.map(p => (
                <option key={p.id} value={p.id}>{p.product_code} — {p.product_name}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Expiry Status</label>
            <select
              value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500"
            >
              <option value="">All</option>
              <option value="VALID">Valid</option>
              <option value="EXPIRING_SOON">Expiring Soon (≤ 90 days)</option>
              <option value="EXPIRED">Expired</option>
              <option value="NO_EXPIRY">No Expiry</option>
            </select>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
          <span className="text-sm font-semibold text-slate-700">Batch Register</span>
          <span className="text-xs text-slate-400">{filtered.length} of {rows.length} batches</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Product</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Batch No</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Mfg. Date</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Expiry Date</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Status</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-slate-600">Purchase Rate</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-slate-600">MRP</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-slate-600">Qty on Hand</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-slate-400">No batches found</td>
                </tr>
              ) : (
                filtered.map(r => {
                  const badge = EXPIRY_BADGE[r.expiry_status];
                  return (
                    <tr key={r.batch_id} className="hover:bg-slate-50">
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-800">{r.product_name}</div>
                        <div className="text-xs text-slate-400">{r.product_code}</div>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-700">{r.batch_no}</td>
                      <td className="px-4 py-3 text-slate-500">{r.manufacture_date ?? '—'}</td>
                      <td className="px-4 py-3 text-slate-500">{r.expiry_date ?? '—'}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${badge.cls}`}>
                          {badge.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right text-slate-700">
                        {r.purchase_rate != null ? `₹${Number(r.purchase_rate).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '—'}
                      </td>
                      <td className="px-4 py-3 text-right text-slate-700">
                        {r.mrp != null ? `₹${Number(r.mrp).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '—'}
                      </td>
                      <td className={`px-4 py-3 text-right font-semibold ${Number(r.qty_on_hand) <= 0 ? 'text-red-600' : 'text-slate-900'}`}>
                        {Number(r.qty_on_hand).toFixed(3)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
