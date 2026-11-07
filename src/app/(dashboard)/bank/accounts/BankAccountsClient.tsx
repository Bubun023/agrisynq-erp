'use client';

import { useState, useTransition } from 'react';
import { createBankAccount } from '@/actions/bank';
import type { BankAccount } from '@/actions/bank';

type Props = { initialAccounts: BankAccount[] };

const ACCOUNT_TYPES = ['CURRENT', 'SAVINGS', 'CASH_CREDIT', 'OVERDRAFT', 'FIXED_DEPOSIT'];

const today = new Date().toISOString().split('T')[0];

function fmt(n: number | undefined) {
  if (n === undefined || n === null) return '—';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 }).format(n);
}

export default function BankAccountsClient({ initialAccounts }: Props) {
  const [accounts, setAccounts] = useState<BankAccount[]>(initialAccounts);
  const [showForm, setShowForm] = useState(false);
  const [error, setError]       = useState('');
  const [success, setSuccess]   = useState('');
  const [isPending, startTransition] = useTransition();

  const [form, setForm] = useState({
    account_name:    '',
    account_no:      '',
    bank_name:       '',
    branch_name:     '',
    ifsc_code:       '',
    account_type:    'CURRENT',
    opening_balance: '0',
    opening_date:    today,
    notes:           '',
  });

  function handleChange(e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) {
    setForm(prev => ({ ...prev, [e.target.name]: e.target.value }));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(''); setSuccess('');
    if (!form.account_name || !form.account_no || !form.bank_name) {
      setError('Account Name, Account No and Bank Name are required.');
      return;
    }
    startTransition(async () => {
      const result = await createBankAccount({
        account_name:    form.account_name,
        account_no:      form.account_no,
        bank_name:       form.bank_name,
        branch_name:     form.branch_name || undefined,
        ifsc_code:       form.ifsc_code || undefined,
        account_type:    form.account_type,
        opening_balance: parseFloat(form.opening_balance) || 0,
        opening_date:    form.opening_date,
        notes:           form.notes || undefined,
      });
      if (result.error) {
        setError(result.error);
      } else {
        setSuccess(`Bank account "${form.account_name}" created successfully.`);
        setShowForm(false);
        setForm({ account_name: '', account_no: '', bank_name: '', branch_name: '', ifsc_code: '', account_type: 'CURRENT', opening_balance: '0', opening_date: today, notes: '' });
        // Refresh: add new account optimistically
        if (result.data) setAccounts(prev => [...prev, result.data as BankAccount]);
      }
    });
  }

  const totalBalance = accounts.filter(a => a.is_active).reduce((s, a) => s + Number(a.current_balance ?? a.opening_balance), 0);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-slate-500">{accounts.length} account(s) configured</p>
        </div>
        <button
          onClick={() => { setShowForm(true); setError(''); setSuccess(''); }}
          className="px-4 py-2 bg-green-700 text-white text-sm font-medium rounded-lg hover:bg-green-800"
        >
          + Add Bank Account
        </button>
      </div>

      {success && (
        <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm px-4 py-3 rounded-lg">
          {success}
        </div>
      )}

      {/* Total Balance Card */}
      <div className="bg-gradient-to-r from-slate-900 to-green-900 text-white rounded-xl p-6">
        <p className="text-sm text-slate-300 mb-1">Total Bank Balance (Active Accounts)</p>
        <p className="text-4xl font-bold">{fmt(totalBalance)}</p>
        <p className="text-xs text-slate-400 mt-2">{accounts.filter(a => a.is_active).length} active account(s)</p>
      </div>

      {/* New Account Form */}
      {showForm && (
        <div className="bg-white rounded-xl border border-slate-200 p-6">
          <h2 className="text-base font-semibold text-slate-800 mb-4">New Bank Account</h2>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              {[
                { label: 'Account Name *', name: 'account_name', type: 'text', placeholder: 'e.g. SBI Current A/c' },
                { label: 'Account Number *', name: 'account_no', type: 'text', placeholder: 'e.g. 1234567890' },
                { label: 'Bank Name *', name: 'bank_name', type: 'text', placeholder: 'e.g. State Bank of India' },
                { label: 'Branch Name', name: 'branch_name', type: 'text', placeholder: 'e.g. Pune Main Branch' },
                { label: 'IFSC Code', name: 'ifsc_code', type: 'text', placeholder: 'e.g. SBIN0001234' },
                { label: 'Opening Balance (INR)', name: 'opening_balance', type: 'number', placeholder: '0.00' },
                { label: 'Opening Date', name: 'opening_date', type: 'date', placeholder: '' },
              ].map(f => (
                <div key={f.name}>
                  <label className="block text-xs font-medium text-slate-500 mb-1">{f.label}</label>
                  <input
                    type={f.type} name={f.name}
                    value={form[f.name as keyof typeof form]}
                    onChange={handleChange}
                    placeholder={f.placeholder}
                    step={f.type === 'number' ? '0.01' : undefined}
                    className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500"
                  />
                </div>
              ))}
              <div>
                <label className="block text-xs font-medium text-slate-500 mb-1">Account Type</label>
                <select
                  name="account_type" value={form.account_type} onChange={handleChange}
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500"
                >
                  {ACCOUNT_TYPES.map(t => <option key={t} value={t}>{t.replace('_', ' ')}</option>)}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Notes</label>
              <textarea
                name="notes" value={form.notes} onChange={handleChange} rows={2}
                placeholder="Optional notes…"
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500"
              />
            </div>
            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2 rounded-lg">{error}</div>
            )}
            <div className="flex gap-2">
              <button type="submit" disabled={isPending}
                className="px-5 py-2 bg-green-700 text-white text-sm font-medium rounded-lg hover:bg-green-800 disabled:opacity-50">
                {isPending ? 'Saving...' : 'Save Account'}
              </button>
              <button type="button" onClick={() => { setShowForm(false); setError(''); }}
                className="px-5 py-2 bg-slate-100 text-slate-700 text-sm rounded-lg hover:bg-slate-200">
                Cancel
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Accounts Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {accounts.length === 0 ? (
          <div className="col-span-3 bg-white rounded-xl border border-slate-200 p-12 text-center text-slate-400">
            No bank accounts configured yet. Click &quot;+ Add Bank Account&quot; to get started.
          </div>
        ) : (
          accounts.map(acc => (
            <div key={acc.id} className={`bg-white rounded-xl border-2 p-5 space-y-3 ${acc.is_active ? 'border-slate-200' : 'border-slate-100 opacity-60'}`}>
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-semibold text-slate-900">{acc.account_name}</h3>
                  <p className="text-xs text-slate-500 mt-0.5">{acc.bank_name}{acc.branch_name ? ` — ${acc.branch_name}` : ''}</p>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded font-medium ${acc.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                  {acc.account_type.replace('_', ' ')}
                </span>
              </div>
              <div className="font-mono text-sm text-slate-600 bg-slate-50 rounded px-3 py-1.5">
                {acc.account_no}
                {acc.ifsc_code && <span className="ml-2 text-slate-400">| {acc.ifsc_code}</span>}
              </div>
              <div>
                <p className="text-xs text-slate-400">Current Balance</p>
                <p className={`text-2xl font-bold ${Number(acc.current_balance ?? acc.opening_balance) >= 0 ? 'text-slate-900' : 'text-red-600'}`}>
                  {fmt(Number(acc.current_balance ?? acc.opening_balance))}
                </p>
              </div>
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span>
                  {acc.unmatched_count
                    ? <span className="text-amber-600 font-medium">{acc.unmatched_count} unmatched stmt line(s)</span>
                    : 'All lines reconciled'}
                </span>
                <span>{acc.last_stmt_date ?? 'No statement'}</span>
              </div>
              {acc.notes && <p className="text-xs text-slate-400 italic">{acc.notes}</p>}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
