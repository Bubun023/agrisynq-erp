'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { formatDate, formatCurrency } from '@/lib/utils';
import { CreditCard, Plus, X, AlertCircle, ArrowDownCircle, ArrowUpCircle } from 'lucide-react';
import { createPaymentReceipt, postPaymentReceipt } from '@/actions/accounting';
import AllocateDialog from './AllocateDialog';

type Allocation = { id: string; invoice_type: string; invoice_id: string; allocated_amount: number };

type Receipt = {
  id: string;
  receipt_no: string;
  receipt_date: string;
  receipt_type: 'RECEIPT' | 'PAYMENT';
  payment_mode: string;
  amount: number;
  status: 'DRAFT' | 'POSTED' | 'CANCELLED';
  cheque_no: string | null;
  utr_no: string | null;
  narration: string | null;
  created_at: string;
  party: { id: string; name: string; gstin: string | null; party_type: string } | null;
  bank_account: { id: string; account_code: string; account_name: string } | null;
  allocations: Allocation[];
};

const PAYMENT_MODES = ['CASH', 'CHEQUE', 'NEFT', 'RTGS', 'IMPS', 'UPI', 'DD', 'OTHER'];
const STATUS_FILTERS = ['ALL', 'DRAFT', 'POSTED', 'CANCELLED'] as const;

export default function ReceiptsClient({ initialData }: { initialData: Receipt[] }) {
  const [receipts, setReceipts] = useState<Receipt[]>(initialData);
  const [statusFilter, setStatusFilter] = useState<typeof STATUS_FILTERS[number]>('ALL');
  const [typeFilter, setTypeFilter] = useState<'ALL' | 'RECEIPT' | 'PAYMENT'>('ALL');
  const [search, setSearch] = useState('');
  const [showSlide, setShowSlide] = useState(false);
  const [postingId, setPostingId] = useState<string | null>(null);
  const [allocatingId, setAllocatingId] = useState<string | null>(null);

  async function handlePost(r: Receipt) {
    if (!confirm(`Post ${r.receipt_no}? This creates the accounting entry and settles the invoices you allocated (or the oldest ones if you did not allocate). It cannot be edited afterwards.`)) return;
    setPostingId(r.id);
    const res = await postPaymentReceipt(r.id);
    setPostingId(null);
    if (!res.success) { toast.error(res.error ?? 'Failed to post.'); return; }
    setReceipts((p) => p.map((x) => (x.id === r.id ? { ...x, status: 'POSTED' } : x)));
    toast.success(`${r.receipt_no} posted.`);
  }

  const filtered = receipts.filter((r) => {
    const matchStatus = statusFilter === 'ALL' || r.status === statusFilter;
    const matchType = typeFilter === 'ALL' || r.receipt_type === typeFilter;
    const q = search.toLowerCase();
    const matchSearch = !q || r.receipt_no.toLowerCase().includes(q) || r.party?.name.toLowerCase().includes(q) || r.utr_no?.toLowerCase().includes(q) || r.cheque_no?.toLowerCase().includes(q);
    return matchStatus && matchType && matchSearch;
  });

  const totalIn  = filtered.filter((r) => r.receipt_type === 'RECEIPT' && r.status === 'POSTED').reduce((s, r) => s + r.amount, 0);
  const totalOut = filtered.filter((r) => r.receipt_type === 'PAYMENT' && r.status === 'POSTED').reduce((s, r) => s + r.amount, 0);

  return (
    <div className="space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Payment Receipts</h1>
          <p className="page-subtitle">Record money received from customers and payments made to suppliers.</p>
        </div>
        <button onClick={() => setShowSlide(true)} className="btn-primary flex items-center gap-2"><Plus className="w-4 h-4" />New Entry</button>
      </div>

      {/* Summary */}
      <div className="grid grid-cols-3 gap-4">
        <div className="card p-4 flex items-center gap-4">
          <div className="p-3 rounded-xl bg-leaf-50"><ArrowDownCircle className="w-6 h-6 text-leaf-600" /></div>
          <div>
            <div className="text-xs text-ink-muted">Total Received (Posted)</div>
            <div className="text-xl font-bold text-leaf-700">{formatCurrency(totalIn)}</div>
          </div>
        </div>
        <div className="card p-4 flex items-center gap-4">
          <div className="p-3 rounded-xl bg-red-50"><ArrowUpCircle className="w-6 h-6 text-red-500" /></div>
          <div>
            <div className="text-xs text-ink-muted">Total Paid (Posted)</div>
            <div className="text-xl font-bold text-red-600">{formatCurrency(totalOut)}</div>
          </div>
        </div>
        <div className="card p-4 flex items-center gap-4">
          <div className="p-3 rounded-xl bg-gold-50"><CreditCard className="w-6 h-6 text-gold-600" /></div>
          <div>
            <div className="text-xs text-ink-muted">Net Cash Position</div>
            <div className={cn('text-xl font-bold', totalIn - totalOut >= 0 ? 'text-leaf-700' : 'text-red-600')}>{formatCurrency(totalIn - totalOut)}</div>
          </div>
        </div>
      </div>

      <div className="card p-4 flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
        <div className="flex gap-2 flex-wrap">
          {(['ALL', 'RECEIPT', 'PAYMENT'] as const).map((t) => (
            <button key={t} onClick={() => setTypeFilter(t)} className={cn('px-3 py-1.5 rounded-full text-xs font-medium border transition-colors', typeFilter === t ? 'bg-navy-950 text-white border-navy-950' : 'bg-surface-subtle text-ink-muted border-surface-border hover:border-navy-700')}>
              {t === 'ALL' ? 'All' : t === 'RECEIPT' ? '📥 Receipts' : '📤 Payments'}
            </button>
          ))}
          <span className="w-px bg-surface-border" />
          {STATUS_FILTERS.map((s) => (
            <button key={s} onClick={() => setStatusFilter(s)} className={cn('px-3 py-1.5 rounded-full text-xs font-medium border transition-colors', statusFilter === s ? 'bg-leaf-600 text-white border-leaf-600' : 'bg-surface-subtle text-ink-muted border-surface-border hover:border-leaf-600')}>
              {s.charAt(0) + s.slice(1).toLowerCase()}
            </button>
          ))}
        </div>
        <input type="search" placeholder="Search receipt no, party, UTR…" value={search} onChange={(e) => setSearch(e.target.value)} className="form-input w-full sm:w-64 text-sm" />
      </div>

      <div className="card overflow-hidden">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <CreditCard className="w-12 h-12 text-ink-faint mb-4" />
            <p className="text-ink-muted font-medium">No receipts / payments found</p>
            <button onClick={() => setShowSlide(true)} className="btn-primary mt-4 flex items-center gap-2"><Plus className="w-4 h-4" />New Entry</button>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Receipt No</th><th>Date</th><th>Type</th><th>Party</th><th>Mode</th>
                <th>Ref No</th><th className="text-right">Amount</th><th>Status</th><th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.id}>
                  <td><span className="font-mono text-sm text-leaf-700">{r.receipt_no}</span></td>
                  <td className="text-sm">{formatDate(r.receipt_date)}</td>
                  <td>
                    <span className={cn('badge text-2xs', r.receipt_type === 'RECEIPT' ? 'badge-success' : 'badge-danger')}>
                      {r.receipt_type === 'RECEIPT' ? '📥 Receipt' : '📤 Payment'}
                    </span>
                  </td>
                  <td>
                    <div className="text-sm font-medium">{r.party?.name ?? '—'}</div>
                    {r.party?.gstin && <div className="font-mono text-xs text-ink-faint">{r.party.gstin}</div>}
                  </td>
                  <td><span className="badge badge-info text-2xs">{r.payment_mode}</span></td>
                  <td className="font-mono text-xs text-ink-muted">{r.cheque_no || r.utr_no || '—'}</td>
                  <td className={cn('text-right font-mono font-semibold', r.receipt_type === 'RECEIPT' ? 'text-leaf-700' : 'text-red-600')}>
                    {r.receipt_type === 'PAYMENT' ? '−' : '+'}{formatCurrency(r.amount)}
                  </td>
                  <td><span className={cn('badge', r.status === 'POSTED' ? 'badge-success' : r.status === 'DRAFT' ? 'badge-warning' : 'badge-danger')}>{r.status.charAt(0) + r.status.slice(1).toLowerCase()}</span></td>
                  <td className="text-right">
                    {r.status === 'DRAFT' && (
                      <button onClick={() => setAllocatingId(r.id)} className="mr-2 rounded border border-slate-300 px-3 py-1 text-xs hover:bg-slate-50">Allocate</button>
                    )}
                    {r.status === 'DRAFT' && (
                      <button onClick={() => handlePost(r)} disabled={postingId === r.id} className="btn-primary text-xs px-3 py-1 disabled:opacity-50">
                        {postingId === r.id ? 'Posting…' : 'Post'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {allocatingId && (
        <AllocateDialog receiptId={allocatingId} onClose={() => setAllocatingId(null)} onSaved={() => setAllocatingId(null)} />
      )}

      {showSlide && (
        <NewReceiptSlideOver
          onClose={() => setShowSlide(false)}
          onCreated={(r) => { setReceipts((p) => [r as Receipt, ...p]); setShowSlide(false); toast.success(`${r.receipt_type === 'RECEIPT' ? 'Receipt' : 'Payment'} ${r.receipt_no} created.`); }}
        />
      )}
    </div>
  );
}

function NewReceiptSlideOver({ onClose, onCreated }: { onClose: () => void; onCreated: (r: { receipt_no: string; receipt_type: string; [k: string]: unknown }) => void }) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState('');
  const [mode, setMode] = useState('CASH');

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); setError('');
    const fd = new FormData(e.currentTarget);
    const input = {
      receipt_no:      String(fd.get('receipt_no') ?? ''),
      receipt_date:    String(fd.get('receipt_date') ?? ''),
      receipt_type:    String(fd.get('receipt_type') ?? '') as 'RECEIPT' | 'PAYMENT',
      party_id:        String(fd.get('party_id') ?? ''),
      bank_account_id: String(fd.get('bank_account_id') ?? '') || null,
      payment_mode:    String(fd.get('payment_mode') ?? '') as typeof PAYMENT_MODES[number],
      amount:          Number(fd.get('amount') ?? 0),
      cheque_no:       String(fd.get('cheque_no') ?? '') || null,
      cheque_date:     String(fd.get('cheque_date') ?? '') || null,
      bank_name:       String(fd.get('bank_name') ?? '') || null,
      utr_no:          String(fd.get('utr_no') ?? '') || null,
      narration:       String(fd.get('narration') ?? '') || null,
    };
    startTransition(async () => {
      const res = await createPaymentReceipt(input as Parameters<typeof createPaymentReceipt>[0]);
      if (res.success && res.data) onCreated(res.data as { receipt_no: string; receipt_type: string });
      else setError(res.error ?? 'Failed to create');
    });
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40 animate-fade-in" onClick={onClose} aria-hidden />
      <div className="fixed inset-y-0 right-0 z-50 w-[560px] max-w-full bg-white shadow-2xl flex flex-col animate-slide-in-right overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-border bg-surface-subtle shrink-0">
          <h2 className="text-base font-semibold text-navy-950">New Receipt / Payment</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-surface-border rounded-lg"><X className="w-5 h-5 text-ink-muted" /></button>
        </div>
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto">
          <div className="px-6 py-5 space-y-4">
            {error && <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700"><AlertCircle className="w-4 h-4 shrink-0" />{error}</div>}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="form-label">Receipt No *</label>
                <input name="receipt_no" className="form-input" placeholder="RV-2025-001" required />
              </div>
              <div>
                <label className="form-label">Date *</label>
                <input name="receipt_date" type="date" className="form-input" defaultValue={new Date().toISOString().split('T')[0]} required />
              </div>
              <div className="col-span-2">
                <label className="form-label">Transaction Type *</label>
                <select name="receipt_type" className="form-input" required>
                  <option value="RECEIPT">📥 Receipt — Money IN from Customer</option>
                  <option value="PAYMENT">📤 Payment — Money OUT to Supplier</option>
                </select>
              </div>
              <div className="col-span-2">
                <label className="form-label">Party ID (Customer / Supplier) *</label>
                <input name="party_id" className="form-input font-mono text-sm" placeholder="UUID of party" required />
              </div>
              <div className="col-span-2">
                <label className="form-label">Bank / Cash Account ID</label>
                <input name="bank_account_id" className="form-input font-mono text-sm" placeholder="UUID of Chart of Account" />
              </div>
              <div>
                <label className="form-label">Payment Mode *</label>
                <select name="payment_mode" className="form-input" value={mode} onChange={(e) => setMode(e.target.value)} required>
                  {PAYMENT_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div>
                <label className="form-label">Amount (₹) *</label>
                <input name="amount" type="number" min={0.01} step={0.01} className="form-input" placeholder="0.00" required />
              </div>
              {mode === 'CHEQUE' && (
                <>
                  <div>
                    <label className="form-label">Cheque No</label>
                    <input name="cheque_no" className="form-input" placeholder="123456" />
                  </div>
                  <div>
                    <label className="form-label">Cheque Date</label>
                    <input name="cheque_date" type="date" className="form-input" />
                  </div>
                  <div className="col-span-2">
                    <label className="form-label">Bank Name</label>
                    <input name="bank_name" className="form-input" placeholder="HDFC / SBI…" />
                  </div>
                </>
              )}
              {['NEFT', 'RTGS', 'IMPS', 'UPI'].includes(mode) && (
                <div className="col-span-2">
                  <label className="form-label">UTR / Reference No</label>
                  <input name="utr_no" className="form-input font-mono" placeholder="UTR number" />
                </div>
              )}
              <div className="col-span-2">
                <label className="form-label">Narration</label>
                <textarea name="narration" className="form-input" rows={2} placeholder="Brief description of the transaction" />
              </div>
            </div>
          </div>
          <div className="px-6 py-4 border-t border-surface-border bg-surface-subtle flex justify-end gap-3 shrink-0">
            <button type="button" onClick={onClose} className="btn-ghost">Cancel</button>
            <button type="submit" disabled={isPending} className="btn-primary flex items-center gap-2">
              <CreditCard className={cn('w-4 h-4', isPending && 'animate-spin')} />
              {isPending ? 'Saving…' : 'Save Entry'}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
