'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { formatDate } from '@/lib/utils';
import {
  Truck, Plus, X, ArrowLeftRight, ChevronDown,
  Package, MapPin, AlertCircle,
} from 'lucide-react';
import {
  createStockTransfer,
  dispatchStockTransfer,
} from '@/actions/logistics';
import { ApproveTransferDialog, ReceiveTransferDialog } from '@/components/logistics/TransferDialogs';

// ─── Types ──────────────────────────────────────────────────────────────────
type TransferItem = {
  id: string;
  product_id: string;
  source_batch_id: string;
  unit_of_measure: string;
  requested_qty: number;
  dispatched_qty: number | null;
  received_qty: number | null;
  unit_cost: number;
  product: { id: string; name: string; product_code: string } | null;
  batch: { id: string; batch_number: string; expiry_date: string | null } | null;
};

type Transfer = {
  id: string;
  transfer_no: string;
  transfer_date: string;
  transfer_type: string;
  status: 'DRAFT' | 'APPROVED' | 'IN_TRANSIT' | 'RECEIVED' | 'CANCELLED';
  cnf_withdrawal_req_no?: string | null;
  cnf_company_approval_ref?: string | null;
  source_location_id: string;
  destination_location_id: string;
  vehicle_no: string | null;
  driver_name: string | null;
  lr_rr_no: string | null;
  eway_bill_no: string | null;
  remarks: string | null;
  created_at: string;
  source_location: { id: string; name: string; location_type: string } | null;
  destination_location: { id: string; name: string; location_type: string } | null;
  transporter: { id: string; legal_name: string; gstin: string | null } | null;
  items: TransferItem[];
};

// ─── Line item for new transfer form ────────────────────────────────────────
type FormLine = {
  product_id: string;
  source_batch_id: string;
  unit_of_measure: string;
  requested_qty: number;
  unit_cost: number;
  remarks: string;
};

const TRANSFER_TYPES = [
  { value: 'INTER_BRANCH', label: 'Inter Branch' },
  { value: 'CNF_TO_OWN_WAREHOUSE', label: 'C&F → Own Warehouse' },
  { value: 'CNF_DIRECT_TO_CUSTOMER', label: 'C&F Direct to Customer' },
  { value: 'QUARANTINE_TRANSFER', label: 'Quarantine Transfer' },
  { value: 'DAMAGE_TRANSFER', label: 'Damage Transfer' },
];

const STATUS_FILTERS = ['ALL', 'DRAFT', 'APPROVED', 'IN_TRANSIT', 'RECEIVED', 'CANCELLED'] as const;
type StatusFilter = typeof STATUS_FILTERS[number];

// ─── Badge helpers ────────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: Transfer['status'] }) {
  const map: Record<Transfer['status'], string> = {
    DRAFT: 'badge badge-warning',
    APPROVED: 'badge badge-info',
    IN_TRANSIT: 'badge badge-info',
    RECEIVED: 'badge badge-success',
    CANCELLED: 'badge badge-danger',
  };
  const labels: Record<Transfer['status'], string> = {
    DRAFT: 'Draft',
    APPROVED: 'Approved',
    IN_TRANSIT: 'In Transit',
    RECEIVED: 'Received',
    CANCELLED: 'Cancelled',
  };
  return <span className={map[status]}>{labels[status]}</span>;
}

function TypeBadge({ type }: { type: string }) {
  const label = TRANSFER_TYPES.find((t) => t.value === type)?.label ?? type;
  return <span className="badge badge-info text-2xs">{label}</span>;
}

// ─── Main Component ──────────────────────────────────────────────────────────
export default function StockTransfersClient({
  initialData,
}: {
  initialData: Transfer[];
}) {
  const [transfers, setTransfers] = useState<Transfer[]>(initialData);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [search, setSearch] = useState('');
  const [showSlide, setShowSlide] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [approving, setApproving] = useState<Transfer | null>(null);
  const [receiving, setReceiving] = useState<Transfer | null>(null);
  const [isPending, startTransition] = useTransition();

  // ─── Filter ────────────────────────────────────────────────────────────────
  const filtered = transfers.filter((t) => {
    const matchStatus = statusFilter === 'ALL' || t.status === statusFilter;
    const q = search.toLowerCase();
    const matchSearch =
      !q ||
      t.transfer_no.toLowerCase().includes(q) ||
      t.source_location?.name.toLowerCase().includes(q) ||
      t.destination_location?.name.toLowerCase().includes(q) ||
      t.transporter?.legal_name.toLowerCase().includes(q);
    return matchStatus && matchSearch;
  });

  // ─── Dispatch ──────────────────────────────────────────────────────────────
  function handleDispatch(id: string, transferNo: string) {
    if (!confirm(`Dispatch transfer ${transferNo}? This will move stock OUT and set status to IN TRANSIT.`)) return;
    startTransition(async () => {
      const res = await dispatchStockTransfer(id);
      if (res.success) {
        toast.success(`Transfer ${transferNo} dispatched. Stock OUT recorded.`);
        setTransfers((prev) =>
          prev.map((t) => (t.id === id ? { ...t, status: 'IN_TRANSIT' } : t))
        );
      } else {
        toast.error(res.error ?? 'Failed to dispatch');
      }
    });
  }

  // ─── Receive (dialog records received / damaged per line) ──────────────────
  const isCnf = (t: Transfer) => t.transfer_type === 'CNF_TO_OWN_WAREHOUSE' || t.transfer_type === 'CNF_DIRECT_TO_CUSTOMER';

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Stock Transfers</h1>
          <p className="page-subtitle">
            Move stock between branches, warehouses, and C&amp;F agents with full audit trail.
          </p>
        </div>
        <button
          onClick={() => setShowSlide(true)}
          className="btn-primary flex items-center gap-2"
        >
          <Plus className="w-4 h-4" />
          New Transfer
        </button>
      </div>

      {/* Filters */}
      <div className="card p-4 flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between">
        <div className="flex gap-2 flex-wrap">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={cn(
                'px-3 py-1.5 rounded-full text-xs font-medium border transition-colors',
                statusFilter === s
                  ? 'bg-leaf-600 text-white border-leaf-600'
                  : 'bg-surface-subtle text-ink-muted border-surface-border hover:border-leaf-600'
              )}
            >
              {s === 'IN_TRANSIT' ? 'In Transit' : s.charAt(0) + s.slice(1).toLowerCase()}
              {s !== 'ALL' && (
                <span className="ml-1.5 bg-navy-800 text-navy-300 px-1 rounded-full">
                  {transfers.filter((t) => t.status === s).length}
                </span>
              )}
            </button>
          ))}
        </div>
        <input
          type="search"
          placeholder="Search by transfer no, location, transporter…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="form-input w-full sm:w-64 text-sm"
        />
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <ArrowLeftRight className="w-12 h-12 text-ink-faint mb-4" />
            <p className="text-ink-muted font-medium">No transfers found</p>
            <p className="text-ink-faint text-sm mt-1">
              {statusFilter !== 'ALL'
                ? `No ${statusFilter.toLowerCase()} transfers`
                : 'Create your first stock transfer to get started'}
            </p>
            {statusFilter === 'ALL' && (
              <button
                onClick={() => setShowSlide(true)}
                className="btn-primary mt-4 flex items-center gap-2"
              >
                <Plus className="w-4 h-4" />
                New Transfer
              </button>
            )}
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Transfer No</th>
                <th>Date</th>
                <th>Type</th>
                <th>From</th>
                <th>To</th>
                <th>Transporter</th>
                <th className="text-center">Items</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((t) => (
                <>
                  <tr
                    key={t.id}
                    className="cursor-pointer hover:bg-surface-subtle"
                    onClick={() => setExpandedId(expandedId === t.id ? null : t.id)}
                  >
                    <td>
                      <span className="font-mono text-sm text-leaf-700">{t.transfer_no}</span>
                    </td>
                    <td className="text-sm">{formatDate(t.transfer_date)}</td>
                    <td><TypeBadge type={t.transfer_type} /></td>
                    <td>
                      <div className="flex items-center gap-1">
                        <MapPin className="w-3 h-3 text-ink-faint" />
                        <span className="text-sm">{t.source_location?.name ?? '—'}</span>
                      </div>
                    </td>
                    <td>
                      <div className="flex items-center gap-1">
                        <MapPin className="w-3 h-3 text-leaf-500" />
                        <span className="text-sm">{t.destination_location?.name ?? '—'}</span>
                      </div>
                    </td>
                    <td className="text-sm text-ink-muted">
                      {t.transporter?.legal_name ?? <span className="text-ink-faint">—</span>}
                    </td>
                    <td className="text-center">
                      <span className="badge badge-info">{t.items.length}</span>
                    </td>
                    <td><StatusBadge status={t.status} /></td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <div className="flex gap-2">
                        {t.status === 'DRAFT' && isCnf(t) && (
                          <button
                            onClick={() => setApproving(t)}
                            disabled={isPending}
                            className="btn-sm bg-navy-700 hover:bg-navy-800 text-white font-semibold"
                          >
                            Approve
                          </button>
                        )}
                        {((t.status === 'DRAFT' && !isCnf(t)) || t.status === 'APPROVED') && (
                          <button
                            onClick={() => handleDispatch(t.id, t.transfer_no)}
                            disabled={isPending}
                            className="btn-sm bg-gold-500 hover:bg-gold-600 text-navy-950 font-semibold"
                          >
                            Dispatch
                          </button>
                        )}
                        {t.status === 'IN_TRANSIT' && (
                          <button
                            onClick={() => setReceiving(t)}
                            disabled={isPending}
                            className="btn-sm bg-leaf-600 hover:bg-leaf-700 text-white font-semibold"
                          >
                            Receive
                          </button>
                        )}
                        <button
                          onClick={() => setExpandedId(expandedId === t.id ? null : t.id)}
                          className="btn-sm btn-ghost flex items-center gap-1"
                        >
                          <ChevronDown
                            className={cn(
                              'w-3.5 h-3.5 transition-transform',
                              expandedId === t.id && 'rotate-180'
                            )}
                          />
                          Items
                        </button>
                      </div>
                    </td>
                  </tr>
                  {expandedId === t.id && (
                    <tr key={`${t.id}-exp`} className="bg-surface-subtle">
                      <td colSpan={9} className="px-4 py-3">
                        <div className="text-xs font-semibold text-ink-faint uppercase tracking-wider mb-2">
                          Transfer Items
                        </div>
                        {t.items.length === 0 ? (
                          <p className="text-ink-faint text-sm">No items</p>
                        ) : (
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="text-left text-ink-faint text-xs uppercase">
                                <th className="pb-1 pr-4">Product</th>
                                <th className="pb-1 pr-4">Batch</th>
                                <th className="pb-1 pr-4">UoM</th>
                                <th className="pb-1 pr-4">Requested</th>
                                <th className="pb-1 pr-4">Dispatched</th>
                                <th className="pb-1">Received</th>
                              </tr>
                            </thead>
                            <tbody>
                              {t.items.map((item) => (
                                <tr key={item.id} className="border-t border-surface-border">
                                  <td className="py-1 pr-4 font-medium">
                                    {item.product?.name ?? item.product_id}
                                    <span className="ml-2 text-ink-faint font-mono text-xs">
                                      {item.product?.product_code}
                                    </span>
                                  </td>
                                  <td className="py-1 pr-4 font-mono text-xs">
                                    {item.batch?.batch_number ?? '—'}
                                  </td>
                                  <td className="py-1 pr-4">{item.unit_of_measure}</td>
                                  <td className="py-1 pr-4">{item.requested_qty}</td>
                                  <td className="py-1 pr-4">{item.dispatched_qty ?? '—'}</td>
                                  <td className="py-1">{item.received_qty ?? '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                        {(t.eway_bill_no || t.lr_rr_no || t.vehicle_no) && (
                          <div className="mt-2 flex gap-4 text-xs text-ink-muted pt-2 border-t border-surface-border">
                            {t.vehicle_no && <span>🚛 {t.vehicle_no}</span>}
                            {t.lr_rr_no && <span>LR/RR: {t.lr_rr_no}</span>}
                            {t.eway_bill_no && <span>E-Way: {t.eway_bill_no}</span>}
                          </div>
                        )}
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* New Transfer Slide-Over */}
      {approving && (
        <ApproveTransferDialog
          transfer={approving}
          onClose={() => setApproving(null)}
          onDone={() => { setTransfers((p) => p.map((x) => (x.id === approving.id ? { ...x, status: 'APPROVED' } : x))); setApproving(null); }}
        />
      )}
      {receiving && (
        <ReceiveTransferDialog
          transfer={receiving}
          onClose={() => setReceiving(null)}
          onDone={() => { setTransfers((p) => p.map((x) => (x.id === receiving.id ? { ...x, status: 'RECEIVED' } : x))); setReceiving(null); }}
        />
      )}

      {showSlide && (
        <NewTransferSlideOver
          onClose={() => setShowSlide(false)}
          onCreated={(t) => {
            setTransfers((prev) => [t as Transfer, ...prev]);
            setShowSlide(false);
            toast.success(`Transfer ${t.transfer_no} created.`);
          }}
        />
      )}
    </div>
  );
}

// ─── New Transfer Slide-Over ─────────────────────────────────────────────────
function NewTransferSlideOver({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (t: { id: string; transfer_no: string; [k: string]: unknown }) => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState('');
  const [lines, setLines] = useState<FormLine[]>([
    { product_id: '', source_batch_id: '', unit_of_measure: '', requested_qty: 1, unit_cost: 0, remarks: '' },
  ]);

  function addLine() {
    setLines((l) => [
      ...l,
      { product_id: '', source_batch_id: '', unit_of_measure: '', requested_qty: 1, unit_cost: 0, remarks: '' },
    ]);
  }

  function removeLine(i: number) {
    setLines((l) => l.filter((_, idx) => idx !== i));
  }

  function updateLine(i: number, field: keyof FormLine, value: string | number) {
    setLines((l) => l.map((row, idx) => (idx === i ? { ...row, [field]: value } : row)));
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    const fd = new FormData(e.currentTarget);

    const input = {
      transfer_no: String(fd.get('transfer_no') ?? ''),
      transfer_date: String(fd.get('transfer_date') ?? ''),
      transfer_type: String(fd.get('transfer_type') ?? '') as Parameters<typeof createStockTransfer>[0]['transfer_type'],
      source_location_id: String(fd.get('source_location_id') ?? ''),
      destination_location_id: String(fd.get('destination_location_id') ?? ''),
      cf_agent_id: String(fd.get('cf_agent_id') ?? '') || null,
      cnf_withdrawal_req_no: String(fd.get('cnf_withdrawal_req_no') ?? '') || null,
      cnf_company_approval_ref: String(fd.get('cnf_company_approval_ref') ?? '') || null,
      cnf_delivery_order_no: String(fd.get('cnf_delivery_order_no') ?? '') || null,
      transporter_id: String(fd.get('transporter_id') ?? '') || null,
      vehicle_no: String(fd.get('vehicle_no') ?? '') || null,
      driver_name: String(fd.get('driver_name') ?? '') || null,
      driver_mobile: String(fd.get('driver_mobile') ?? '') || null,
      lr_rr_no: String(fd.get('lr_rr_no') ?? '') || null,
      eway_bill_no: String(fd.get('eway_bill_no') ?? '') || null,
      remarks: String(fd.get('remarks') ?? '') || null,
      items: lines.map((l) => ({
        product_id: l.product_id,
        source_batch_id: l.source_batch_id,
        unit_of_measure: l.unit_of_measure,
        requested_qty: Number(l.requested_qty),
        unit_cost: Number(l.unit_cost),
        remarks: l.remarks || null,
      })),
    };

    startTransition(async () => {
      const res = await createStockTransfer(input);
      if (res.success && res.data) {
        onCreated(res.data as { id: string; transfer_no: string });
      } else {
        setError(res.error ?? 'Failed to create transfer');
      }
    });
  }

  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 bg-black/50 z-40 animate-fade-in"
        onClick={onClose}
        aria-hidden
      />
      {/* Panel */}
      <div className="fixed inset-y-0 right-0 z-50 w-[680px] max-w-full bg-white shadow-2xl flex flex-col animate-slide-in-right overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-border bg-surface-subtle shrink-0">
          <div>
            <h2 className="text-base font-semibold text-navy-950">New Stock Transfer</h2>
            <p className="text-xs text-ink-muted mt-0.5">
              Move stock between locations — dispatch creates a TRANSFER OUT stock ledger entry.
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-surface-border rounded-lg transition-colors">
            <X className="w-5 h-5 text-ink-muted" />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto">
          <div className="px-6 py-5 space-y-6">
            {error && (
              <div className="flex items-center gap-2 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                <AlertCircle className="w-4 h-4 shrink-0" />
                {error}
              </div>
            )}

            {/* Header fields */}
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-faint mb-3">
                Transfer Details
              </h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="form-label">Transfer No *</label>
                  <input name="transfer_no" className="form-input" placeholder="STK-2025-001" required />
                </div>
                <div>
                  <label className="form-label">Transfer Date *</label>
                  <input name="transfer_date" type="date" className="form-input" defaultValue={new Date().toISOString().split('T')[0]} required />
                </div>
                <div className="col-span-2">
                  <label className="form-label">Transfer Type *</label>
                  <select name="transfer_type" className="form-input" required>
                    {TRANSFER_TYPES.map((t) => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="form-label">Source Location ID *</label>
                  <input name="source_location_id" className="form-input font-mono text-sm" placeholder="UUID of source location" required />
                </div>
                <div>
                  <label className="form-label">Destination Location ID *</label>
                  <input name="destination_location_id" className="form-input font-mono text-sm" placeholder="UUID of destination location" required />
                </div>
                <div>
                  <label className="form-label">C&amp;F Agent ID</label>
                  <input name="cf_agent_id" className="form-input font-mono text-sm" placeholder="UUID (if applicable)" />
                </div>
                <div>
                  <label className="form-label">C&amp;F Withdrawal Req No</label>
                  <input name="cnf_withdrawal_req_no" className="form-input" placeholder="WDL-2025-001" />
                </div>
                <div>
                  <label className="form-label">C&amp;F Company Approval Ref</label>
                  <input name="cnf_company_approval_ref" className="form-input" placeholder="Approval reference" />
                </div>
                <div>
                  <label className="form-label">C&amp;F Delivery Order No</label>
                  <input name="cnf_delivery_order_no" className="form-input" placeholder="DO-2025-001" />
                </div>
              </div>
            </section>

            {/* Transporter */}
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-faint mb-3">
                Transporter &amp; Vehicle
              </h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="form-label">Transporter ID</label>
                  <input name="transporter_id" className="form-input font-mono text-sm" placeholder="UUID (optional)" />
                </div>
                <div>
                  <label className="form-label">Vehicle No</label>
                  <input name="vehicle_no" className="form-input" placeholder="MH-01-AB-1234" />
                </div>
                <div>
                  <label className="form-label">Driver Name</label>
                  <input name="driver_name" className="form-input" placeholder="Driver name" />
                </div>
                <div>
                  <label className="form-label">Driver Mobile</label>
                  <input name="driver_mobile" className="form-input" placeholder="+91 98765 43210" />
                </div>
                <div>
                  <label className="form-label">LR / RR No</label>
                  <input name="lr_rr_no" className="form-input" placeholder="Lorry receipt number" />
                </div>
                <div>
                  <label className="form-label">E-Way Bill No</label>
                  <input name="eway_bill_no" className="form-input font-mono" placeholder="EWB-XXXXXXXXXXXXXXXX" />
                </div>
                <div className="col-span-2">
                  <label className="form-label">Remarks</label>
                  <textarea name="remarks" className="form-input" rows={2} placeholder="Any additional notes…" />
                </div>
              </div>
            </section>

            {/* Line items */}
            <section>
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-faint">
                  Transfer Items *
                </h3>
                <button type="button" onClick={addLine} className="btn-ghost text-xs flex items-center gap-1">
                  <Plus className="w-3.5 h-3.5" />
                  Add Item
                </button>
              </div>
              <div className="space-y-3">
                {lines.map((line, i) => (
                  <div key={i} className="p-3 border border-surface-border rounded-lg bg-surface-subtle space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-ink-muted flex items-center gap-1">
                        <Package className="w-3.5 h-3.5" />
                        Item {i + 1}
                      </span>
                      {lines.length > 1 && (
                        <button type="button" onClick={() => removeLine(i)} className="text-red-400 hover:text-red-600 p-0.5">
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="form-label text-xs">Product ID *</label>
                        <input
                          value={line.product_id}
                          onChange={(e) => updateLine(i, 'product_id', e.target.value)}
                          className="form-input font-mono text-xs"
                          placeholder="UUID"
                          required
                        />
                      </div>
                      <div>
                        <label className="form-label text-xs">Batch ID *</label>
                        <input
                          value={line.source_batch_id}
                          onChange={(e) => updateLine(i, 'source_batch_id', e.target.value)}
                          className="form-input font-mono text-xs"
                          placeholder="UUID"
                          required
                        />
                      </div>
                      <div>
                        <label className="form-label text-xs">UoM *</label>
                        <input
                          value={line.unit_of_measure}
                          onChange={(e) => updateLine(i, 'unit_of_measure', e.target.value)}
                          className="form-input text-sm"
                          placeholder="BAG / KG / MT"
                          required
                        />
                      </div>
                      <div>
                        <label className="form-label text-xs">Requested Qty *</label>
                        <input
                          type="number"
                          min={0.001}
                          step={0.001}
                          value={line.requested_qty}
                          onChange={(e) => updateLine(i, 'requested_qty', Number(e.target.value))}
                          className="form-input text-sm"
                          required
                        />
                      </div>
                      <div>
                        <label className="form-label text-xs">Unit Cost (₹)</label>
                        <input
                          type="number"
                          min={0}
                          step={0.01}
                          value={line.unit_cost}
                          onChange={(e) => updateLine(i, 'unit_cost', Number(e.target.value))}
                          className="form-input text-sm"
                        />
                      </div>
                      <div>
                        <label className="form-label text-xs">Remarks</label>
                        <input
                          value={line.remarks}
                          onChange={(e) => updateLine(i, 'remarks', e.target.value)}
                          className="form-input text-sm"
                          placeholder="Optional"
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>

          {/* Footer */}
          <div className="px-6 py-4 border-t border-surface-border bg-surface-subtle flex justify-end gap-3 shrink-0">
            <button type="button" onClick={onClose} className="btn-ghost">
              Cancel
            </button>
            <button
              type="submit"
              disabled={isPending}
              className="btn-primary flex items-center gap-2"
            >
              <Truck className={cn('w-4 h-4', isPending && 'animate-spin')} />
              {isPending ? 'Creating…' : 'Create Transfer'}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
