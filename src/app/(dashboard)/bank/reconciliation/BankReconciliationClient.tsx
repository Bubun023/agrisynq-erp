'use client';

import { useState, useTransition } from 'react';
import { matchStatementLine, unmatchStatementLine, excludeStatementLine } from '@/actions/bank';
import type { BankStatementLine, BankAccount } from '@/actions/bank';

type Props = {
  initialLines: BankStatementLine[];
  bankAccounts: BankAccount[];
};

function fmt(n: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 }).format(n);
}

export default function BankReconciliationClient({ initialLines, bankAccounts }: Props) {
  const [lines, setLines]               = useState<BankStatementLine[]>(initialLines);
  const [selectedAccountId, setSelectedAccountId] = useState(bankAccounts[0]?.id ?? '');
  const [activeLineId, setActiveLineId] = useState<string | null>(null);
  const [matchRef, setMatchRef]         = useState('');
  const [matchNotes, setMatchNotes]     = useState('');
  const [actionMsg, setActionMsg]       = useState('');
  const [isPending, startTransition]    = useTransition();

  const unmatched = lines.filter(l =>
    l.recon_status === 'UNMATCHED' &&
    (!selectedAccountId || l.bank_account_id === selectedAccountId)
  );
  const matched = lines.filter(l =>
    (l.recon_status === 'MATCHED' || l.recon_status === 'MANUALLY_MATCHED') &&
    (!selectedAccountId || l.bank_account_id === selectedAccountId)
  );

  const totalUnmatchedCredits = unmatched.filter(l => l.txn_type === 'CREDIT').reduce((s, l) => s + Number(l.amount), 0);
  const totalUnmatchedDebits  = unmatched.filter(l => l.txn_type === 'DEBIT').reduce((s, l) => s + Number(l.amount), 0);

  function handleManualMatch(lineId: string) {
    startTransition(async () => {
      const result = await matchStatementLine({ line_id: lineId, notes: matchRef || matchNotes || 'Manual match' });
      if (result.error) { setActionMsg('Error: ' + result.error); return; }
      setLines(prev => prev.map(l => l.id === lineId ? { ...l, recon_status: 'MANUALLY_MATCHED' } : l));
      setActiveLineId(null); setMatchRef(''); setMatchNotes('');
      setActionMsg('Line manually matched.');
    });
  }

  function handleUnmatch(lineId: string) {
    startTransition(async () => {
      const result = await unmatchStatementLine(lineId);
      if (result.error) { setActionMsg('Error: ' + result.error); return; }
      setLines(prev => prev.map(l => l.id === lineId ? { ...l, recon_status: 'UNMATCHED', matched_jv_id: null, matched_receipt_id: null } : l));
      setActionMsg('Line moved back to unmatched.');
    });
  }

  function handleExclude(lineId: string) {
    startTransition(async () => {
      const result = await excludeStatementLine(lineId, 'Excluded manually');
      if (result.error) { setActionMsg('Error: ' + result.error); return; }
      setLines(prev => prev.map(l => l.id === lineId ? { ...l, recon_status: 'EXCLUDED' } : l));
      setActionMsg('Line excluded from reconciliation.');
    });
  }

  return (
    <div className="space-y-6">
      {/* Account selector */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 flex items-center gap-4">
        <div className="flex-1">
          <label className="block text-xs font-medium text-slate-500 mb-1">Bank Account</label>
          <select
            value={selectedAccountId} onChange={e => setSelectedAccountId(e.target.value)}
            className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500"
          >
            <option value="">All Accounts</option>
            {bankAccounts.map(a => <option key={a.id} value={a.id}>{a.account_name} ({a.account_no})</option>)}
          </select>
        </div>
        <div className="text-right">
          <p className="text-xs text-slate-500">Unmatched Lines</p>
          <p className={`text-3xl font-bold ${unmatched.length > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>
            {unmatched.length}
          </p>
        </div>
      </div>

      {actionMsg && (
        <div className="bg-blue-50 border border-blue-200 text-blue-800 text-sm px-4 py-3 rounded-lg">
          {actionMsg}
        </div>
      )}

      {/* Summary Row */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Unmatched Credits', value: fmt(totalUnmatchedCredits), color: 'text-emerald-700', bg: 'bg-emerald-50' },
          { label: 'Unmatched Debits',  value: fmt(totalUnmatchedDebits),  color: 'text-red-700',     bg: 'bg-red-50' },
          { label: 'Matched',           value: matched.length,             color: 'text-slate-800',   bg: 'bg-white' },
        ].map(k => (
          <div key={k.label} className={`${k.bg} rounded-xl border border-slate-200 p-4`}>
            <p className="text-xs text-slate-500 mb-1">{k.label}</p>
            <p className={`text-2xl font-bold ${k.color}`}>{k.value}</p>
          </div>
        ))}
      </div>

      {/* Unmatched Lines */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100 bg-amber-50 flex items-center justify-between">
          <span className="text-sm font-semibold text-amber-900">Unmatched Lines ({unmatched.length})</span>
          <span className="text-xs text-amber-700">Click a row to manually match or exclude</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Date</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Description</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Ref</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-slate-600">Credit</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-slate-600">Debit</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {unmatched.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-emerald-600 font-medium">All lines reconciled!</td></tr>
              ) : (
                unmatched.map(l => (
                  <>
                    <tr key={l.id} className="hover:bg-amber-50 cursor-pointer" onClick={() => setActiveLineId(activeLineId === l.id ? null : l.id)}>
                      <td className="px-4 py-3 text-slate-600 whitespace-nowrap">{l.value_date}</td>
                      <td className="px-4 py-3 text-slate-800 max-w-sm truncate">{l.description}</td>
                      <td className="px-4 py-3 text-xs text-slate-500">{l.ref_no ?? l.cheque_no ?? '—'}</td>
                      <td className="px-4 py-3 text-right font-medium text-emerald-700">
                        {l.txn_type === 'CREDIT' ? fmt(Number(l.amount)) : '—'}
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-red-600">
                        {l.txn_type === 'DEBIT' ? fmt(Number(l.amount)) : '—'}
                      </td>
                      <td className="px-4 py-3">
                        <span className="text-xs text-blue-600 underline">
                          {activeLineId === l.id ? 'Close' : 'Match / Exclude'}
                        </span>
                      </td>
                    </tr>
                    {activeLineId === l.id && (
                      <tr key={`${l.id}-action`} className="bg-slate-50">
                        <td colSpan={6} className="px-6 py-4">
                          <div className="flex items-end gap-3">
                            <div className="flex-1">
                              <label className="block text-xs font-medium text-slate-500 mb-1">Reference / Notes</label>
                              <input
                                type="text" value={matchRef}
                                onChange={e => setMatchRef(e.target.value)}
                                placeholder="JV no, receipt no, or notes..."
                                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500"
                              />
                            </div>
                            <button
                              onClick={() => handleManualMatch(l.id)}
                              disabled={isPending}
                              className="px-4 py-2 bg-emerald-700 text-white text-xs font-medium rounded-lg hover:bg-emerald-800 disabled:opacity-50 whitespace-nowrap"
                            >
                              Mark Matched
                            </button>
                            <button
                              onClick={() => handleExclude(l.id)}
                              disabled={isPending}
                              className="px-4 py-2 bg-slate-200 text-slate-700 text-xs font-medium rounded-lg hover:bg-slate-300 disabled:opacity-50"
                            >
                              Exclude
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Matched Lines */}
      {matched.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 bg-emerald-50">
            <span className="text-sm font-semibold text-emerald-900">Matched Lines ({matched.length})</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Date</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Description</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-slate-600">Credit</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-slate-600">Debit</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Status</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {matched.map(l => (
                  <tr key={l.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 text-slate-600">{l.value_date}</td>
                    <td className="px-4 py-3 text-slate-700 max-w-sm truncate">{l.description}</td>
                    <td className="px-4 py-3 text-right text-emerald-700">
                      {l.txn_type === 'CREDIT' ? fmt(Number(l.amount)) : '—'}
                    </td>
                    <td className="px-4 py-3 text-right text-red-600">
                      {l.txn_type === 'DEBIT' ? fmt(Number(l.amount)) : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${l.recon_status === 'MATCHED' ? 'bg-emerald-100 text-emerald-700' : 'bg-blue-100 text-blue-700'}`}>
                        {l.recon_status === 'MATCHED' ? 'Matched' : 'Manual'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => handleUnmatch(l.id)}
                        disabled={isPending}
                        className="text-xs text-slate-400 hover:text-red-600 underline disabled:opacity-50"
                      >
                        Unmatch
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
