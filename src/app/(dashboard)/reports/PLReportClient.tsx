'use client';

import { useState, useTransition } from 'react';
import type { PLRow } from '@/actions/reports';

type Props = { initialRows: PLRow[] };

const MONTH_NAMES = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmt(n: number) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency', currency: 'INR', minimumFractionDigits: 2
  }).format(n);
}

const currentYear  = new Date().getFullYear();
const currentMonth = new Date().getMonth() + 1;

function toYYYYMM(year: number, month: number) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

export default function PLReportClient({ initialRows }: Props) {
  const [rows, setRows]         = useState<PLRow[]>(initialRows);
  const [fromMonth, setFromMonth] = useState(toYYYYMM(currentYear, 4));  // Apr = FY start
  const [toMonth, setToMonth]   = useState(toYYYYMM(currentYear, currentMonth));
  const [isPending, startTransition] = useTransition();

  function loadReport() {
    startTransition(async () => {
      const { getPLReport } = await import('@/actions/reports');
      const data = await getPLReport({ fromMonth, toMonth });
      setRows(data);
    });
  }

  // Group by account_type
  const incomeRows  = rows.filter(r => r.account_type === 'INCOME');
  const expenseRows = rows.filter(r => r.account_type === 'EXPENSE');

  // Aggregate by account (sum across months in range)
  const incomeByAccount  = aggregateByAccount(incomeRows);
  const expenseByAccount = aggregateByAccount(expenseRows);

  const totalIncome  = incomeByAccount.reduce((s, r)  => s + r.net, 0);
  const totalExpense = expenseByAccount.reduce((s, r) => s + r.net, 0);
  const netPL        = totalIncome - totalExpense;

  return (
    <div className="space-y-4">
      {/* Filter Bar */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 flex items-end gap-4">
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">From Month</label>
          <input type="month" value={fromMonth} onChange={e => setFromMonth(e.target.value)}
            className="text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500" />
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-500 mb-1">To Month</label>
          <input type="month" value={toMonth} onChange={e => setToMonth(e.target.value)}
            className="text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500" />
        </div>
        <button onClick={loadReport} disabled={isPending}
          className="px-5 py-2 bg-green-700 text-white text-sm font-medium rounded-lg hover:bg-green-800 disabled:opacity-50">
          {isPending ? 'Loading...' : 'Generate'}
        </button>
      </div>

      {/* Net P&L Banner */}
      <div className={`rounded-xl p-6 text-white ${netPL >= 0 ? 'bg-gradient-to-r from-green-800 to-emerald-700' : 'bg-gradient-to-r from-red-900 to-red-700'}`}>
        <p className="text-sm opacity-80">Net Profit / Loss</p>
        <p className="text-4xl font-bold mt-1">{fmt(netPL)}</p>
        <div className="flex gap-6 mt-3 text-sm opacity-80">
          <span>Income: {fmt(totalIncome)}</span>
          <span>Expenses: {fmt(totalExpense)}</span>
        </div>
      </div>

      {/* Two Column Layout */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Income */}
        <AccountTable
          title="Income"
          rows={incomeByAccount}
          total={totalIncome}
          totalLabel="Total Income"
          totalColor="text-emerald-700"
          headerColor="bg-emerald-50"
        />
        {/* Expenses */}
        <AccountTable
          title="Expenses"
          rows={expenseByAccount}
          total={totalExpense}
          totalLabel="Total Expenses"
          totalColor="text-red-700"
          headerColor="bg-red-50"
        />
      </div>
    </div>
  );
}

function aggregateByAccount(rows: PLRow[]) {
  const map = new Map<string, { code: string; name: string; net: number }>();
  for (const r of rows) {
    const key = r.account_code;
    const existing = map.get(key);
    if (existing) existing.net += Number(r.net_amount);
    else map.set(key, { code: r.account_code, name: r.account_name, net: Number(r.net_amount) });
  }
  return Array.from(map.values()).sort((a, b) => a.code.localeCompare(b.code));
}

function AccountTable({ title, rows, total, totalLabel, totalColor, headerColor }: {
  title: string;
  rows: { code: string; name: string; net: number }[];
  total: number;
  totalLabel: string;
  totalColor: string;
  headerColor: string;
}) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      <div className={`px-4 py-3 border-b border-slate-200 ${headerColor}`}>
        <span className="font-semibold text-slate-800">{title}</span>
      </div>
      <table className="w-full text-sm">
        <thead className="bg-slate-50 border-b border-slate-100">
          <tr>
            <th className="px-4 py-2 text-left text-xs font-semibold text-slate-500">Code</th>
            <th className="px-4 py-2 text-left text-xs font-semibold text-slate-500">Account</th>
            <th className="px-4 py-2 text-right text-xs font-semibold text-slate-500">Amount</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-50">
          {rows.length === 0 ? (
            <tr><td colSpan={3} className="px-4 py-6 text-center text-slate-400">No data</td></tr>
          ) : (
            rows.map(r => (
              <tr key={r.code} className="hover:bg-slate-50">
                <td className="px-4 py-2.5 font-mono text-xs text-slate-500">{r.code}</td>
                <td className="px-4 py-2.5 text-slate-700">{r.name}</td>
                <td className="px-4 py-2.5 text-right font-medium text-slate-800">{fmt(r.net)}</td>
              </tr>
            ))
          )}
        </tbody>
        <tfoot className="border-t-2 border-slate-200 bg-slate-50">
          <tr>
            <td colSpan={2} className="px-4 py-3 font-bold text-slate-800">{totalLabel}</td>
            <td className={`px-4 py-3 text-right font-bold text-lg ${totalColor}`}>{fmt(total)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
