'use client';

import { useState } from 'react';

type Transfer = {
  id: string;
  transfer_no: string;
  transfer_date: string;
  status: string;
  products?: { product_name: string; product_code: string } | null;
  from_location?: { location_name: string } | null;
  to_location?: { location_name: string } | null;
  inventory_batches?: { batch_no: string } | null;
  quantity: number;
  uom?: string | null;
  notes?: string | null;
};

type Props = {
  initialRows: Transfer[];
  products:    { id: string; product_name: string; product_code: string }[];
};

const STATUS_BADGE: Record<string, string> = {
  DRAFT:      'bg-slate-100 text-slate-600',
  DISPATCHED: 'bg-amber-100 text-amber-800',
  RECEIVED:   'bg-emerald-100 text-emerald-700',
  CANCELLED:  'bg-red-100 text-red-600',
};

export default function StockTransfersClient({ initialRows, products }: Props) {
  const [rows]             = useState<Transfer[]>(initialRows);
  const [search, setSearch]   = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [productFilter, setProductFilter] = useState('');

  const filtered = rows.filter(r => {
    const matchSearch  = !search || r.transfer_no.toLowerCase().includes(search.toLowerCase()) ||
      (r.products?.product_name ?? '').toLowerCase().includes(search.toLowerCase());
    const matchStatus  = !statusFilter  || r.status === statusFilter;
    const matchProduct = !productFilter || r.products?.product_code === productFilter;
    return matchSearch && matchStatus && matchProduct;
  });

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Search</label>
            <input
              type="text" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Transfer no, product…"
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Status</label>
            <select
              value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500"
            >
              <option value="">All Statuses</option>
              <option value="DRAFT">Draft</option>
              <option value="DISPATCHED">Dispatched</option>
              <option value="RECEIVED">Received</option>
              <option value="CANCELLED">Cancelled</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Product</label>
            <select
              value={productFilter} onChange={e => setProductFilter(e.target.value)}
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500"
            >
              <option value="">All Products</option>
              {products.map(p => (
                <option key={p.id} value={p.product_code}>{p.product_code} — {p.product_name}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* KPI */}
      <div className="grid grid-cols-4 gap-3">
        {['DRAFT', 'DISPATCHED', 'RECEIVED', 'CANCELLED'].map(status => {
          const count = rows.filter(r => r.status === status).length;
          return (
            <div key={status} className="bg-white rounded-xl border border-slate-200 p-4">
              <p className="text-xs text-slate-500 mb-1">{status}</p>
              <p className={`text-2xl font-bold ${STATUS_BADGE[status]?.split(' ')[1] ?? 'text-slate-700'}`}>{count}</p>
            </div>
          );
        })}
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
          <span className="text-sm font-semibold text-slate-700">Stock Transfer Log</span>
          <span className="text-xs text-slate-400">{filtered.length} of {rows.length} transfers</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Transfer No</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Date</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Product</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Batch</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">From</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">To</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-slate-600">Qty</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Status</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-slate-400">
                    No stock transfers found
                  </td>
                </tr>
              ) : (
                filtered.map(r => (
                  <tr key={r.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 font-mono text-xs text-slate-700">{r.transfer_no}</td>
                    <td className="px-4 py-3 text-slate-600">{r.transfer_date}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-800">{r.products?.product_name ?? '—'}</div>
                      <div className="text-xs text-slate-400">{r.products?.product_code}</div>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">{r.inventory_batches?.batch_no ?? '—'}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{r.from_location?.location_name ?? '—'}</td>
                    <td className="px-4 py-3 text-sm text-slate-600">{r.to_location?.location_name ?? '—'}</td>
                    <td className="px-4 py-3 text-right font-semibold text-slate-900">{Number(r.quantity).toFixed(3)}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${STATUS_BADGE[r.status] ?? 'bg-slate-100 text-slate-600'}`}>
                        {r.status}
                      </span>
                    </td>
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
