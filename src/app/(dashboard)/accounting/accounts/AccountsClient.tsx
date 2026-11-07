'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { BookOpen, Plus, X, AlertCircle, Layers, RefreshCw } from 'lucide-react';
import { createAccount, seedSystemAccounts } from '@/actions/accounting';

type Account = {
  id: string;
  account_code: string;
  account_name: string;
  account_type: 'ASSET' | 'LIABILITY' | 'INCOME' | 'EXPENSE' | 'EQUITY';
  account_group: string;
  is_control_account: boolean;
  control_type: string | null;
  opening_balance: number;
  opening_balance_type: 'DR' | 'CR';
  is_active: boolean;
  is_system: boolean;
  parent: { id: string; account_name: string; account_code: string } | null;
};

const TYPE_COLORS: Record<Account['account_type'], string> = {
  ASSET:     'badge badge-success',
  LIABILITY: 'badge badge-danger',
  INCOME:    'badge badge-info',
  EXPENSE:   'badge badge-warning',
  EQUITY:    'badge',
};

const ACCOUNT_TYPES: Account['account_type'][] = ['ASSET', 'LIABILITY', 'INCOME', 'EXPENSE', 'EQUITY'];
const TYPE_FILTERS = ['ALL', ...ACCOUNT_TYPES] as const;

export default function AccountsClient({ initialData }: { initialData: Account[] }) {
  const [accounts, setAccounts] = useState<Account[]>(initialData);
  const [typeFilter, setTypeFilter] = useState<typeof TYPE_FILTERS[number]>('ALL');
  const [search, setSearch] = useState('');
  const [showSlide, setShowSlide] = useState(false);
  const [isPending, startTransition] = useTransition();

  const filtered = accounts.filter((a) => {
    const matchType = typeFilter === 'ALL' || a.account_type === typeFilter;
    const q = search.toLowerCase();
    const matchSearch = !q || a.account_code.toLowerCase().includes(q) || a.account_name.toLowerCase().includes(q) || a.account_group.toLowerCase().includes(q);
    return matchType && matchSearch;
  });

  // Totals for active accounts
  const totals = ACCOUNT_TYPES.map((t) => ({
    type: t,
    count: accounts.filter((a) => a.account_type === t && a.is_active).length,
  }));

  function handleSeed() {
    if (!confirm('Seed the standard FertiLedger chart of accounts? Existing accounts with the same code will be skipped.')) return;
    startTransition(async () => {
      const res = await seedSystemAccounts();
      if (res.success) {
        toast.success(`Seeded ${res.count} system accounts. Refresh to see them.`);
      } else {
        toast.error(res.error ?? 'Seed failed');
      }
    });
  }

  return (
    <div className="space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Chart of Accounts</h1>
          <p className="page-subtitle">Double-entry ledger structure — assets, liabilities, income, expense &amp; equity.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={handleSeed} disabled={isPending} className="btn-ghost flex items-center gap-2 text-sm">
            <RefreshCw className={cn('w-4 h-4', isPending && 'animate-spin')} />
            Seed Defaults
          </button>
          <button onClick={() => setShowSlide(true)} className="btn-primary flex items-center gap-2">
            <Plus className="w-4 h-4" />
            New Account
          </button>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-5 gap-3">
        {totals.map((t) => (
          <button
            key={t.type}
            onClick={() => setTypeFilter(typeFilter === t.type ? 'ALL' : t.type)}
            className={cn(
              'card p-4 text-left transition-all hover:shadow-md',
              typeFilter === t.type && 'ring-2 ring-leaf-600'
            )}
          >
            <div className="text-2xl font-bold text-navy-950">{t.count}</div>
            <div className="text-xs text-ink-muted mt-1">{t.type.charAt(0) + t.type.slice(1).toLowerCase()}</div>
          </button>
        ))}
      </div>

      <div className="card p-4 flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
        <div className="flex gap-2 flex-wrap">
          {TYPE_FILTERS.map((f) => (
            <button
              key={f}
              onClick={() => setTypeFilter(f)}
              className={cn(
                'px-3 py-1.5 rounded-full text-xs font-medium border transition-colors',
                typeFilter === f ? 'bg-leaf-600 text-white border-leaf-600' : 'bg-surface-subtle text-ink-muted border-surface-border hover:border-leaf-600'
              )}
            >
              {f.charAt(0) + f.slice(1).toLowerCase()}
            </button>
          ))}
        </div>
        <input type="search" placeholder="Search code, name, group…" value={search} onChange={(e) => setSearch(e.target.value)} className="form-input w-full sm:w-64 text-sm" />
      </div>

      <div className="card overflow-hidden">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <BookOpen className="w-12 h-12 text-ink-faint mb-4" />
            <p className="text-ink-muted font-medium">No accounts found</p>
            <p className="text-ink-faint text-sm mt-1">Click &quot;Seed Defaults&quot; to load the standard chart of accounts, or create manually.</p>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Account Name</th>
                <th>Type</th>
                <th>Group</th>
                <th>Parent</th>
                <th>Control</th>
                <th className="text-right">Opening Balance</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((a) => (
                <tr key={a.id} className={cn(!a.is_active && 'opacity-50')}>
                  <td><span className="font-mono text-sm font-semibold text-navy-800">{a.account_code}</span></td>
                  <td>
                    <span className="font-medium">{a.account_name}</span>
                    {a.is_system && <span className="ml-2 text-2xs text-ink-faint bg-surface-subtle px-1 rounded">SYS</span>}
                  </td>
                  <td><span className={TYPE_COLORS[a.account_type]}>{a.account_type}</span></td>
                  <td className="text-sm text-ink-muted">{a.account_group || '—'}</td>
                  <td className="text-sm text-ink-muted">{a.parent ? `${a.parent.account_code} — ${a.parent.account_name}` : '—'}</td>
                  <td>
                    {a.is_control_account && a.control_type
                      ? <span className="badge badge-info text-2xs">{a.control_type}</span>
                      : <span className="text-ink-faint">—</span>}
                  </td>
                  <td className="text-right font-mono text-sm">
                    {a.opening_balance > 0 ? (
                      <span className={a.opening_balance_type === 'DR' ? 'text-navy-800' : 'text-red-600'}>
                        ₹{a.opening_balance.toLocaleString('en-IN', { minimumFractionDigits: 2 })} {a.opening_balance_type}
                      </span>
                    ) : '—'}
                  </td>
                  <td>
                    <span className={a.is_active ? 'badge badge-success' : 'badge badge-danger'}>
                      {a.is_active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {showSlide && (
        <NewAccountSlideOver
          onClose={() => setShowSlide(false)}
          onCreated={(a) => { setAccounts((p) => [...p, a as Account]); setShowSlide(false); toast.success(`Account ${a.account_code} created.`); }}
        />
      )}
    </div>
  );
}

function NewAccountSlideOver({ onClose, onCreated }: { onClose: () => void; onCreated: (a: { account_code: string; [k: string]: unknown }) => void }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState('');
  const [isControl, setIsControl] = useState(false);

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError('');
    const fd = new FormData(e.currentTarget);
    const input = {
      account_code:         String(fd.get('account_code') ?? ''),
      account_name:         String(fd.get('account_name') ?? ''),
      account_type:         String(fd.get('account_type') ?? '') as Account['account_type'],
      account_group:        String(fd.get('account_group') ?? ''),
      parent_account_id:    String(fd.get('parent_account_id') ?? '') || null,
      is_control_account:   fd.get('is_control_account') === 'on',
      control_type:         (String(fd.get('control_type') ?? '') || null) as 'DEBTOR' | 'CREDITOR' | 'BANK' | 'CASH' | 'STOCK' | 'TAX' | null,
      opening_balance:      Number(fd.get('opening_balance') ?? 0),
      opening_balance_type: String(fd.get('opening_balance_type') ?? 'DR') as 'DR' | 'CR',
    };
    startTransition(async () => {
      const res = await createAccount(input);
      if (res.success && res.data) onCreated(res.data as { account_code: string });
      else setError(res.error ?? 'Failed to create account');
    });
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40 animate-fade-in" onClick={onClose} aria-hidden />
      <div className="fixed inset-y-0 right-0 z-50 w-[540px] max-w-full bg-white shadow-2xl flex flex-col animate-slide-in-right overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-border bg-surface-subtle shrink-0">
          <h2 className="text-base font-semibold text-navy-950">New Account</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-surface-border rounded-lg"><X className="w-5 h-5 text-ink-muted" /></button>
        </div>
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto">
          <div className="px-6 py-5 space-y-4">
            {error && <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700"><AlertCircle className="w-4 h-4 shrink-0" />{error}</div>}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="form-label">Account Code *</label>
                <input name="account_code" className="form-input font-mono" placeholder="1001" required />
              </div>
              <div>
                <label className="form-label">Account Type *</label>
                <select name="account_type" className="form-input" required>
                  {ACCOUNT_TYPES.map((t) => <option key={t} value={t}>{t.charAt(0) + t.slice(1).toLowerCase()}</option>)}
                </select>
              </div>
              <div className="col-span-2">
                <label className="form-label">Account Name *</label>
                <input name="account_name" className="form-input" placeholder="e.g. Cash in Hand" required />
              </div>
              <div className="col-span-2">
                <label className="form-label">Account Group</label>
                <input name="account_group" className="form-input" placeholder="Current Assets, Direct Income…" />
              </div>
              <div className="col-span-2">
                <label className="form-label">Parent Account ID</label>
                <input name="parent_account_id" className="form-input font-mono text-sm" placeholder="UUID (optional)" />
              </div>
              <div>
                <label className="form-label">Opening Balance (₹)</label>
                <input name="opening_balance" type="number" min={0} step={0.01} defaultValue={0} className="form-input" />
              </div>
              <div>
                <label className="form-label">Balance Type</label>
                <select name="opening_balance_type" className="form-input">
                  <option value="DR">Debit (DR)</option>
                  <option value="CR">Credit (CR)</option>
                </select>
              </div>
              <div className="col-span-2 flex items-center gap-3 p-3 border border-surface-border rounded-lg">
                <input
                  type="checkbox"
                  id="is_control"
                  name="is_control_account"
                  checked={isControl}
                  onChange={(e) => setIsControl(e.target.checked)}
                  className="w-4 h-4 rounded border-surface-border text-leaf-600"
                />
                <label htmlFor="is_control" className="text-sm font-medium text-ink cursor-pointer">
                  Control Account (links to AR/AP/Bank/Cash sub-ledger)
                </label>
              </div>
              {isControl && (
                <div className="col-span-2">
                  <label className="form-label">Control Type *</label>
                  <select name="control_type" className="form-input" required>
                    {['DEBTOR', 'CREDITOR', 'BANK', 'CASH', 'STOCK', 'TAX'].map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
              )}
            </div>
          </div>
          <div className="px-6 py-4 border-t border-surface-border bg-surface-subtle flex justify-end gap-3 shrink-0">
            <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
            <button type="submit" disabled={isPending} className="btn-primary flex items-center gap-2">
              <Layers className={cn('w-4 h-4', isPending && 'animate-spin')} />
              {isPending ? 'Creating…' : 'Create Account'}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
