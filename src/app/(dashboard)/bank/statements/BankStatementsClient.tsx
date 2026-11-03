'use client';

import { useState, useTransition, useRef } from 'react';
import { importBankStatementLines } from '@/actions/bank';
import type { BankStatementLine, BankAccount } from '@/actions/bank';

type Props = {
  initialLines:   BankStatementLine[];
  bankAccounts:   BankAccount[];
};

const RECON_BADGE: Record<string, { label: string; cls: string }> = {
  UNMATCHED:        { label: 'Unmatched',  cls: 'bg-amber-100 text-amber-800' },
  MATCHED:          { label: 'Matched',    cls: 'bg-emerald-100 text-emerald-700' },
  MANUALLY_MATCHED: { label: 'Manual',     cls: 'bg-blue-100 text-blue-700' },
  EXCLUDED:         { label: 'Excluded',   cls: 'bg-slate-100 text-slate-500' },
};

function fmt(n: number) {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 }).format(n);
}

// Parse a simple CSV row into cells (handles quoted commas)
function parseCsvRow(row: string): string[] {
  const result: string[] = [];
  let cur = '', inQuotes = false;
  for (const ch of row) {
    if (ch === '"') { inQuotes = !inQuotes; }
    else if (ch === ',' && !inQuotes) { result.push(cur.trim()); cur = ''; }
    else { cur += ch; }
  }
  result.push(cur.trim());
  return result;
}

export default function BankStatementsClient({ initialLines, bankAccounts }: Props) {
  const [lines, setLines]               = useState<BankStatementLine[]>(initialLines);
  const [selectedAccountId, setSelectedAccountId] = useState(bankAccounts[0]?.id ?? '');
  const [reconFilter, setReconFilter]   = useState('');
  const [txnTypeFilter, setTxnTypeFilter] = useState('');
  const [fromDate, setFromDate]         = useState('');
  const [toDate, setToDate]             = useState('');
  const [showImport, setShowImport]     = useState(false);
  const [importError, setImportError]   = useState('');
  const [importSuccess, setImportSuccess] = useState('');
  const [isPending, startTransition]    = useTransition();
  const fileRef                         = useRef<HTMLInputElement>(null);

  // Filters
  const displayed = lines.filter(l => {
    const matchAccount = !selectedAccountId || l.bank_account_id === selectedAccountId;
    const matchRecon   = !reconFilter       || l.recon_status === reconFilter;
    const matchType    = !txnTypeFilter     || l.txn_type === txnTypeFilter;
    const matchFrom    = !fromDate          || l.value_date >= fromDate;
    const matchTo      = !toDate            || l.value_date <= toDate;
    return matchAccount && matchRecon && matchType && matchFrom && matchTo;
  });

  const totalCredits = displayed.filter(l => l.txn_type === 'CREDIT').reduce((s, l) => s + Number(l.amount), 0);
  const totalDebits  = displayed.filter(l => l.txn_type === 'DEBIT').reduce((s, l) => s + Number(l.amount), 0);
  const unmatchedCount = displayed.filter(l => l.recon_status === 'UNMATCHED').length;

  function handleFileImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !selectedAccountId) { setImportError('Select a bank account and a CSV file.'); return; }
    setImportError(''); setImportSuccess('');

    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      const rows = text.split('\n').map(r => r.trim()).filter(r => r.length > 0);
      if (rows.length < 2) { setImportError('CSV must have a header row + at least 1 data row.'); return; }

      // Expected columns: value_date, description, ref_no, cheque_no, credit, debit, balance
      const parsedLines = rows.slice(1).map(row => {
        const cells = parseCsvRow(row);
        const credit = parseFloat(cells[4] ?? '0') || 0;
        const debit  = parseFloat(cells[5] ?? '0') || 0;
        return {
          value_date:  cells[0] ?? '',
          description: cells[1] ?? '',
          ref_no:      cells[2] || undefined,
          cheque_no:   cells[3] || undefined,
          txn_type:    (credit > 0 ? 'CREDIT' : 'DEBIT') as 'CREDIT' | 'DEBIT',
          amount:      credit > 0 ? credit : debit,
          balance:     parseFloat(cells[6] ?? '') || undefined,
        };
      }).filter(l => l.value_date && l.amount > 0);

      if (!parsedLines.length) { setImportError('No valid rows found. Check your CSV format.'); return; }

      startTransition(async () => {
        const result = await importBankStatementLines({
          bank_account_id: selectedAccountId,
          lines: parsedLines,
        });
        if (result.error) {
          setImportError(result.error);
        } else {
          setImportSuccess(`${result.count} lines imported successfully (batch ${result.batchId?.slice(0, 8)}...).`);
          setShowImport(false);
          // Refresh lines locally (prepend)
          const newLines = (result.data ?? []) as BankStatementLine[];
          setLines(prev => [...newLines, ...prev]);
        }
      });
    };
    reader.readAsText(file);
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-slate-500">{lines.length} statement line(s)</p>
        </div>
        <button
          onClick={() => { setShowImport(s => !s); setImportError(''); setImportSuccess(''); }}
          className="px-4 py-2 bg-green-700 text-white text-sm font-medium rounded-lg hover:bg-green-800"
        >
          {showImport ? 'Cancel Import' : 'Import CSV'}
        </button>
      </div>

      {/* Import Panel */}
      {showImport && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-5 space-y-3">
          <h3 className="font-semibold text-amber-900">Import Bank Statement (CSV)</h3>
          <p className="text-xs text-amber-700">
            Expected columns (in order): <code className="bg-amber-100 px-1 rounded">value_date, description, ref_no, cheque_no, credit_amount, debit_amount, balance</code>
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Bank Account</label>
              <select
                value={selectedAccountId}
                onChange={e => setSelectedAccountId(e.target.value)}
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500"
              >
                <option value="">-- Select Account --</option>
                {bankAccounts.map(a => (
                  <option key={a.id} value={a.id}>{a.account_name} ({a.account_no})</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">CSV File</label>
              <input
                ref={fileRef} type="file" accept=".csv"
                onChange={handleFileImport} disabled={isPending}
                className="w-full text-sm text-slate-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-green-700 file:text-white hover:file:bg-green-800"
              />
            </div>
          </div>
          {importError && <div className="text-red-700 text-sm">{importError}</div>}
          {isPending && <div className="text-slate-500 text-sm">Importing...</div>}
        </div>
      )}

      {importSuccess && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm px-4 py-3 rounded-lg">
          {importSuccess}
        </div>
      )}

      {/* Filters */}
      <div className="bg-white rounded-xl border border-slate-200 p-4">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Account</label>
            <select value={selectedAccountId} onChange={e => setSelectedAccountId(e.target.value)}
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500">
              <option value="">All Accounts</option>
              {bankAccounts.map(a => <option key={a.id} value={a.id}>{a.account_name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Recon Status</label>
            <select value={reconFilter} onChange={e => setReconFilter(e.target.value)}
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500">
              <option value="">All</option>
              <option value="UNMATCHED">Unmatched</option>
              <option value="MATCHED">Matched</option>
              <option value="MANUALLY_MATCHED">Manual Match</option>
              <option value="EXCLUDED">Excluded</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1">Type</label>
            <select value={txnTypeFilter} onChange={e => setTxnTypeFilter(e.target.value)}
              className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500">
              <option value="">All</option>
              <option value="CREDIT">Credit</option>
              <option value="DEBIT">Debit</option>
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
      </div>

      {/* KPI */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: 'Total Credits', value: fmt(totalCredits), color: 'text-emerald-700', bg: 'bg-emerald-50' },
          { label: 'Total Debits',  value: fmt(totalDebits),  color: 'text-red-700',     bg: 'bg-red-50' },
          { label: 'Unmatched',     value: unmatchedCount,    color: unmatchedCount > 0 ? 'text-amber-700' : 'text-slate-500', bg: 'bg-amber-50' },
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
          <span className="text-sm font-semibold text-slate-700">Statement Lines</span>
          <span className="text-xs text-slate-400">{displayed.length} rows</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Date</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Description</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Ref / Cheque</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-slate-600">Credit</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-slate-600">Debit</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-slate-600">Balance</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {displayed.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-12 text-center text-slate-400">No statement lines found. Import a CSV to get started.</td></tr>
              ) : (
                displayed.map(l => {
                  const badge = RECON_BADGE[l.recon_status];
                  return (
                    <tr key={l.id} className="hover:bg-slate-50">
                      <td className="px-4 py-3 text-slate-600 whitespace-nowrap">{l.value_date}</td>
                      <td className="px-4 py-3 text-slate-800 max-w-xs truncate">{l.description}</td>
                      <td className="px-4 py-3 text-xs text-slate-500">
                        {l.ref_no ?? ''}{l.cheque_no ? ` / ${l.cheque_no}` : ''}
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-emerald-700">
                        {l.txn_type === 'CREDIT' ? fmt(Number(l.amount)) : '—'}
                      </td>
                      <td className="px-4 py-3 text-right font-medium text-red-600">
                        {l.txn_type === 'DEBIT' ? fmt(Number(l.amount)) : '—'}
                      </td>
                      <td className="px-4 py-3 text-right text-slate-600">
                        {l.balance != null ? fmt(Number(l.balance)) : '—'}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${badge.cls}`}>
                          {badge.label}
                        </span>
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
