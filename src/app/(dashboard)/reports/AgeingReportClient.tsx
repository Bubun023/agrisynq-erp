'use client';

import { useState } from 'react';
import type { AgeingRow } from '@/actions/reports';

type Props = {
  receivables: AgeingRow[];
  payables:    AgeingRow[];
};

const BUCKETS: { key: string; label: string; cls: string }[] = [
  { key: 'NOT_DUE', label: 'Not Due',   cls: 'bg-slate-100 text-slate-600' },
  { key: '1_30',    label: '1-30 days', cls: 'bg-amber-100 text-amber-700' },
  { key: '31_60',   label: '31-60 days',cls: 'bg-orange-100 text-orange-700' },
  { key: '61_90',   label: '61-90 days',cls: 'bg-red-100 text-red-700' },
  { key: 'OVER_90', label: '>90 days',  cls: 'bg-red-200 text-red-900' },
];

function fmt(n: number) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', minimumFractionDigits: 2
  }).format(n);
}

function AgeingTable({ rows, title, color }: { rows: AgeingRow[]; title: string; color: string }) {
  const [search, setSearch] = useState('');
  const filtered = rows.filter(r => !search || r.party_name.toLowerCase().includes(search.toLowerCase()));
  const total = filtered.reduce((s, r) => s + Number(r.outstanding), 0);

  const bucketTotals = BUCKETS.map(b => ({
    ...b,
    total: filtered.filter(r => r.ageing_bucket === b.key).reduce((s, r) => s + Number(r.outstanding), 0),
  }));

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      {/* Header */}
      <div className={`px-4 py-3 border-b border-slate-200 ${color} flex items-center justify-between`}>
        <span className="font-semibold text-slate-800">{title}</span>
        <span className="text-sm font-bold text-slate-800">{fmt(total)}</span>
      </div>

      {/* Bucket Summary */}
      <div className="grid grid-cols-5 border-b border-slate-100">
        {bucketTotals.map(b => (
          <div key={b.key} className="px-3 py-2 text-center border-r border-slate-100 last:border-0">
            <p className="text-xs text-slate-400">{b.label}</p>
            <p className="text-sm font-semibold text-slate-800">{fmt(b.total)}</p>
          </div>
        ))}
      </div>

      {/* Search */}
      <div className="px-4 py-2 border-b border-slate-100">
        <input type="text" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search party..."
          className="w-full text-sm border border-slate-200 rounded-lg px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-green-500" />
      </div>

      {/* Table */}
      <div className="overflow-x-auto max-h-96 overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 border-b border-slate-200 sticky top-0">
            <tr>
              <th className="px-4 py-2 text-left text-xs font-semibold text-slate-600">Party</th>
              <th className="px-4 py-2 text-left text-xs font-semibold text-slate-600">Invoice</th>
              <th className="px-4 py-2 text-left text-xs font-semibold text-slate-600">Date</th>
              <th className="px-4 py-2 text-left text-xs font-semibold text-slate-600">Due Date</th>
              <th className="px-4 py-2 text-right text-xs font-semibold text-slate-600">Invoice Amt</th>
              <th className="px-4 py-2 text-right text-xs font-semibold text-slate-600">Outstanding</th>
              <th className="px-4 py-2 text-left text-xs font-semibold text-slate-600">Bucket</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-50">
            {filtered.length === 0 ? (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">No outstanding found</td></tr>
            ) : (
              filtered.map((r, i) => {
                const bucket = BUCKETS.find(b => b.key === r.ageing_bucket);
                return (
                  <tr key={`${r.invoice_no}-${i}`} className="hover:bg-slate-50">
                    <td className="px-4 py-2 font-medium text-slate-800 max-w-[140px] truncate">{r.party_name}</td>
                    <td className="px-4 py-2 font-mono text-xs text-slate-600">{r.invoice_no}</td>
                    <td className="px-4 py-2 text-slate-500 text-xs whitespace-nowrap">{r.invoice_date}</td>
                    <td className="px-4 py-2 text-slate-500 text-xs whitespace-nowrap">{r.due_date ?? '—'}</td>
                    <td className="px-4 py-2 text-right text-slate-700">{fmt(Number(r.total_amount))}</td>
                    <td className="px-4 py-2 text-right font-semibold text-slate-900">{fmt(Number(r.outstanding))}</td>
                    <td className="px-4 py-2">
                      {bucket && (
                        <span className={`inline-flex px-1.5 py-0.5 rounded text-xs font-medium ${bucket.cls}`}>
                          {bucket.label}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
          <tfoot className="border-t-2 border-slate-200 bg-slate-50 sticky bottom-0">
            <tr>
              <td colSpan={5} className="px-4 py-2 font-bold text-slate-800">Total Outstanding</td>
              <td className="px-4 py-2 text-right font-bold text-slate-900">{fmt(total)}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

export default function AgeingReportClient({ receivables, payables }: Props) {
  const [tab, setTab] = useState<'AR' | 'AP'>('AR');

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {(['AR', 'AP'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-5 py-2 rounded-lg text-sm font-medium transition-colors ${tab === t ? 'bg-green-700 text-white' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'}`}>
            {t === 'AR' ? 'Receivables (AR)' : 'Payables (AP)'}
          </button>
        ))}
      </div>

      {tab === 'AR' && (
        <AgeingTable rows={receivables} title="Outstanding Receivables (AR)" color="bg-emerald-50" />
      )}
      {tab === 'AP' && (
        <AgeingTable rows={payables} title="Outstanding Payables (AP)" color="bg-red-50" />
      )}
    </div>
  );
}
