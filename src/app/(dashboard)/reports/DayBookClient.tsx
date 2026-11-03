'use client';

import { useState, useTransition } from 'react';
import type { DayBookRow } from '@/actions/reports';

type Props = { initialRows: DayBookRow[] };

const DOC_TYPES: Record<string, string> = {
  JOURNAL:          'Journal',
  SALE_INVOICE:     'Sale Invoice',
  PURCHASE_INVOICE: 'Purchase Invoice',
  RECEIPT:          'Receipt',
};

const DOC_COLORS: Record<string, string> = {
  JOURNAL:          'bg-blue-100 text-blue-800',
  SALE_INVOICE:     'bg-emerald-100 text-emerald-700',
  PURCHASE_INVOICE: 'bg-red-100 text-red-700',
  RECEIPT:          'bg-amber-100 text-amber-800',
};

function fmt(n: number) {
  return n > 0
    ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 }).format(n)
    : '—';
}

const today = new Date().toISOString().split('T')[0];

export default function DayBookClient({ initialRows }: Props) {
  const [rows, setRows]         = useState<DayBookRow[]>(initialRows);
  const [fromDate, setFromDate] = useState(today);
  const [toDate, setToDate]     = useState(today);
  const [docType, setDocType]   = useState('');
  const [isPending, startTransition] = useTransition();

  function loadDayBook() {
    startTransition(async () => {
      const { getDayBook } = await import('@/actions/reports');
      const data = await getDayBook({ fromDate, toDate, docType: docType || undefined });
      setRows(data);
    });
  }

  const filtered = rows.filter(r => !docType || r.doc_type === docType);
  const totalDebit  = filtered.reduce((s, r) => s + Number(r.debit_amount),  0);
  const totalCredit = filtered.reduce((s, r) => s + Number(r.credit_amount), 0);

  return (
    <div className="space-y-4">
      {/* Filter */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 flex items-end gap-3">
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">From Date</label>
          <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
            className="text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500" />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">To Date</label>
          <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
            className="text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500" />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">Document Type</label>
          <select value={docType} onChange={e => setDocType(e.target.value)}
            className="text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500">
            <option value="">All Types</option>
            {Object.entries(DOC_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <button onClick={loadDayBook} disabled={isPending}
          className="px-5 py-2 bg-green-700 text-white text-sm font-medium rounded-lg hover:bg-green-800 disabled:opacity-50">
          {isPending ? 'Loading...' : 'Fetch'}
        </button>
      </div>

      {/* Totals */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Total Debit',  val: fmt(totalDebit),  color: 'text-red-700',     bg: 'bg-red-50' },
          { label: 'Total Credit', val: fmt(totalCredit), color: 'text-emerald-700', bg: 'bg-emerald-50' },
          { label: 'Transactions', val: filtered.length,  color: 'text-slate-800',   bg: 'bg-white' },
        ].map(k => (
          <div key={k.label} className={`${k.bg} rounded-xl border border-slate-200 p-4`}>
            <p className="text-xs text-slate-500 mb-1">{k.label}</p>
            <p className={`text-2xl font-bold ${k.color}`}>{k.val}</p>
          </div>
        ))}
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Date</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Type</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Reference</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Description</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-slate-600">Debit</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-slate-600">Credit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-12 text-center text-slate-400">No transactions. Click Fetch to load.</td></tr>
              ) : (
                filtered.map((r, i) => (
                  <tr key={`${r.ref_no}-${i}`} className="hover:bg-slate-50">
                    <td className="px-4 py-3 text-slate-600 whitespace-nowrap">{r.txn_date}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${DOC_COLORS[r.doc_type] ?? 'bg-slate-100 text-slate-600'}`}>
                        {DOC_TYPES[r.doc_type] ?? r.doc_type}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-700">{r.ref_no}</td>
                    <td className="px-4 py-3 text-slate-700 max-w-xs truncate">{r.description}</td>
                    <td className="px-4 py-3 text-right text-red-600 font-medium">{fmt(Number(r.debit_amount))}</td>
                    <td className="px-4 py-3 text-right text-emerald-700 font-medium">{fmt(Number(r.credit_amount))}</td>
                  </tr>
                ))
              )}
            </tbody>
            {filtered.length > 0 && (
              <tfoot className="border-t-2 border-slate-200 bg-slate-50">
                <tr>
                  <td colSpan={4} className="px-4 py-3 font-bold text-slate-800">Total</td>
                  <td className="px-4 py-3 text-right font-bold text-red-700">{fmt(totalDebit)}</td>
                  <td className="px-4 py-3 text-right font-bold text-emerald-700">{fmt(totalCredit)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>
    </div>
  );
}
