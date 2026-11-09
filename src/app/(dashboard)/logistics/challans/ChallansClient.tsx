'use client';

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { formatDate } from '@/lib/utils';
import {
  FileText, Plus, X, ChevronDown, Package,
  MapPin, AlertCircle, Truck,
} from 'lucide-react';
import { createDeliveryChallan } from '@/actions/logistics';

// ─── Types ────────────────────────────────────────────────────────────────────
type ChallanItem = {
  id: string;
  product_id: string;
  batch_id: string;
  unit_of_measure: string;
  qty: number;
  declared_unit_rate: number;
  remarks: string | null;
  product: { id: string; name: string; product_code: string } | null;
  batch: { id: string; batch_number: string } | null;
};

type Challan = {
  id: string;
  challan_no: string;
  challan_date: string;
  purpose: PurposeType;
  status: 'DRAFT' | 'DISPATCHED' | 'DELIVERED' | 'RETURNED' | 'INVOICED' | 'CANCELLED';
  dispatch_location_id: string;
  consignee_name: string;
  consignee_gstin: string | null;
  delivery_address: string;
  place_of_supply_state: string;
  vehicle_no: string | null;
  driver_name: string | null;
  distance_km: number | null;
  eway_bill_no: string | null;
  remarks: string | null;
  created_at: string;
  dispatch_location: { id: string; name: string } | null;
  bill_to_party: { id: string; name: string; gstin: string | null } | null;
  ship_to_party: { id: string; name: string; gstin: string | null } | null;
  transporter: { id: string; legal_name: string; gstin: string | null } | null;
  items: ChallanItem[];
};

type PurposeType =
  | 'DELIVERY_AGAINST_INVOICE'
  | 'STOCK_TRANSFER'
  | 'JOB_WORK_OUT'
  | 'JOB_WORK_RETURN'
  | 'CONSIGNMENT_OUT'
  | 'CONSIGNMENT_RETURN'
  | 'SALE_ON_APPROVAL'
  | 'EXHIBITION_DEMO'
  | 'CF_DISPATCH'
  | 'RETURN_TO_SUPPLIER'
  | 'OTHER_PERMITTED';

// ─── Constants ────────────────────────────────────────────────────────────────
const PURPOSES: { value: PurposeType; label: string; color: string }[] = [
  { value: 'DELIVERY_AGAINST_INVOICE', label: 'Delivery against invoice', color: 'badge-info' },
  { value: 'STOCK_TRANSFER',           label: 'Stock transfer',           color: 'badge-info' },
  { value: 'CF_DISPATCH',              label: 'C&F dispatch',             color: 'badge-warning' },
  { value: 'SALE_ON_APPROVAL',         label: 'Sale on approval',         color: 'badge-warning' },
  { value: 'JOB_WORK_OUT',             label: 'Job work (out)',           color: 'badge' },
  { value: 'JOB_WORK_RETURN',          label: 'Job work (return)',        color: 'badge' },
  { value: 'CONSIGNMENT_OUT',          label: 'Consignment (out)',        color: 'badge' },
  { value: 'CONSIGNMENT_RETURN',       label: 'Consignment (return)',     color: 'badge' },
  { value: 'EXHIBITION_DEMO',          label: 'Exhibition / demo',        color: 'badge' },
  { value: 'RETURN_TO_SUPPLIER',       label: 'Return to supplier',       color: 'badge' },
  { value: 'OTHER_PERMITTED',          label: 'Other permitted movement', color: 'badge' },
];

const STATUS_FILTERS = ['ALL', 'DISPATCHED', 'DELIVERED', 'RETURNED', 'CANCELLED'] as const;
type StatusFilter = typeof STATUS_FILTERS[number];

type FormLine = {
  product_id: string;
  batch_id: string;
  unit_of_measure: string;
  qty: number;
  declared_unit_rate: number;
  remarks: string;
};

// ─── Badge helpers ─────────────────────────────────────────────────────────────
function PurposeBadge({ purpose }: { purpose: PurposeType }) {
  const p = PURPOSES.find((x) => x.value === purpose);
  return <span className={cn('badge text-2xs', p?.color ?? 'badge')}>{p?.label ?? purpose}</span>;
}

function StatusBadge({ status }: { status: Challan['status'] }) {
  const map: Record<Challan['status'], string> = {
    DRAFT:      'badge badge-warning',
    INVOICED:   'badge badge-info',
    DISPATCHED: 'badge badge-warning',
    DELIVERED:  'badge badge-success',
    RETURNED:   'badge badge-danger',
    CANCELLED:  'badge badge-danger',
  };
  return <span className={map[status]}>{status.charAt(0) + status.slice(1).toLowerCase()}</span>;
}

// ─── Main component ────────────────────────────────────────────────────────────
export default function ChallansClient({
  initialData,
}: {
  initialData: Challan[];
}) {
  const [challans, setChallans] = useState<Challan[]>(initialData);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [search, setSearch] = useState('');
  const [showSlide, setShowSlide] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // ─── Filter ──────────────────────────────────────────────────────────────────
  const filtered = challans.filter((c) => {
    const matchStatus = statusFilter === 'ALL' || c.status === statusFilter;
    const q = search.toLowerCase();
    const matchSearch =
      !q ||
      c.challan_no.toLowerCase().includes(q) ||
      c.consignee_name.toLowerCase().includes(q) ||
      c.consignee_gstin?.toLowerCase().includes(q) ||
      c.eway_bill_no?.toLowerCase().includes(q) ||
      c.dispatch_location?.name.toLowerCase().includes(q) ||
      c.transporter?.legal_name.toLowerCase().includes(q);
    return matchStatus && matchSearch;
  });

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Delivery Challans</h1>
          <p className="page-subtitle">
            Issue e-Challans for stock movement — Bill-to-Ship-to, C&amp;F dispatch, approvals, and exhibitions.
          </p>
        </div>
        <button
          onClick={() => setShowSlide(true)}
          className="btn-primary flex items-center gap-2"
        >
          <Plus className="w-4 h-4" />
          New Challan
        </button>
      </div>

      {/* Filter bar */}
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
              {s.charAt(0) + s.slice(1).toLowerCase()}
              {s !== 'ALL' && (
                <span className="ml-1.5 bg-navy-800 text-navy-300 px-1 rounded-full">
                  {challans.filter((c) => c.status === s).length}
                </span>
              )}
            </button>
          ))}
        </div>
        <input
          type="search"
          placeholder="Search challan no, consignee, e-way bill…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="form-input w-full sm:w-72 text-sm"
        />
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <FileText className="w-12 h-12 text-ink-faint mb-4" />
            <p className="text-ink-muted font-medium">No delivery challans found</p>
            <p className="text-ink-faint text-sm mt-1">
              {statusFilter !== 'ALL'
                ? `No ${statusFilter.toLowerCase()} challans`
                : 'Issue your first delivery challan to begin movement documentation'}
            </p>
            {statusFilter === 'ALL' && (
              <button
                onClick={() => setShowSlide(true)}
                className="btn-primary mt-4 flex items-center gap-2"
              >
                <Plus className="w-4 h-4" />
                New Challan
              </button>
            )}
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Challan No</th>
                <th>Date</th>
                <th>Purpose</th>
                <th>Dispatch From</th>
                <th>Consignee</th>
                <th>GSTIN</th>
                <th>Transporter</th>
                <th>E-Way Bill</th>
                <th className="text-center">Items</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c) => (
                <>
                  <tr
                    key={c.id}
                    className="cursor-pointer hover:bg-surface-subtle"
                    onClick={() => setExpandedId(expandedId === c.id ? null : c.id)}
                  >
                    <td>
                      <span className="font-mono text-sm text-leaf-700">{c.challan_no}</span>
                    </td>
                    <td className="text-sm">{formatDate(c.challan_date)}</td>
                    <td><PurposeBadge purpose={c.purpose} /></td>
                    <td>
                      <div className="flex items-center gap-1">
                        <MapPin className="w-3 h-3 text-ink-faint" />
                        <span className="text-sm">{c.dispatch_location?.name ?? '—'}</span>
                      </div>
                    </td>
                    <td className="text-sm font-medium">{c.consignee_name}</td>
                    <td className="font-mono text-xs text-ink-muted">{c.consignee_gstin ?? '—'}</td>
                    <td className="text-sm text-ink-muted">
                      {c.transporter?.legal_name ?? <span className="text-ink-faint">—</span>}
                    </td>
                    <td>
                      {c.eway_bill_no ? (
                        <span className="font-mono text-xs text-gold-600">{c.eway_bill_no}</span>
                      ) : (
                        <span className="text-ink-faint text-xs">—</span>
                      )}
                    </td>
                    <td className="text-center">
                      <span className="badge badge-info">{c.items.length}</span>
                    </td>
                    <td><StatusBadge status={c.status} /></td>
                    <td>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setExpandedId(expandedId === c.id ? null : c.id);
                        }}
                        className="btn-ghost btn-sm flex items-center gap-1"
                      >
                        <ChevronDown
                          className={cn(
                            'w-3.5 h-3.5 transition-transform',
                            expandedId === c.id && 'rotate-180'
                          )}
                        />
                        Details
                      </button>
                    </td>
                  </tr>
                  {expandedId === c.id && (
                    <tr key={`${c.id}-exp`} className="bg-surface-subtle">
                      <td colSpan={11} className="px-4 py-4">
                        <div className="grid grid-cols-2 gap-6">
                          {/* Left: party / address info */}
                          <div className="space-y-2 text-sm">
                            {c.bill_to_party && (
                              <div>
                                <span className="text-xs font-semibold text-ink-faint uppercase">Bill To</span>
                                <p className="font-medium">{c.bill_to_party.name}</p>
                                <p className="font-mono text-xs text-ink-muted">{c.bill_to_party.gstin}</p>
                              </div>
                            )}
                            {c.ship_to_party && (
                              <div>
                                <span className="text-xs font-semibold text-ink-faint uppercase">Ship To</span>
                                <p className="font-medium">{c.ship_to_party.name}</p>
                                <p className="font-mono text-xs text-ink-muted">{c.ship_to_party.gstin}</p>
                              </div>
                            )}
                            <div>
                              <span className="text-xs font-semibold text-ink-faint uppercase">Delivery Address</span>
                              <p className="text-ink-muted text-xs mt-0.5">{c.delivery_address}</p>
                              <p className="text-ink-faint text-xs">State: {c.place_of_supply_state}</p>
                            </div>
                            {(c.vehicle_no || c.driver_name || c.distance_km) && (
                              <div className="flex gap-4 text-xs text-ink-muted pt-1 border-t border-surface-border">
                                {c.vehicle_no && <span>🚛 {c.vehicle_no}</span>}
                                {c.driver_name && <span>👤 {c.driver_name}</span>}
                                {c.distance_km && <span>📍 {c.distance_km} km</span>}
                              </div>
                            )}
                          </div>

                          {/* Right: items table */}
                          <div>
                            <div className="text-xs font-semibold text-ink-faint uppercase mb-2">
                              Challan Items
                            </div>
                            {c.items.length === 0 ? (
                              <p className="text-ink-faint text-sm">No items</p>
                            ) : (
                              <table className="w-full text-sm">
                                <thead>
                                  <tr className="text-left text-ink-faint text-xs uppercase">
                                    <th className="pb-1 pr-3">Product</th>
                                    <th className="pb-1 pr-3">Batch</th>
                                    <th className="pb-1 pr-3">Qty</th>
                                    <th className="pb-1">Rate</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {c.items.map((item) => (
                                    <tr key={item.id} className="border-t border-surface-border">
                                      <td className="py-1 pr-3 font-medium">
                                        {item.product?.name ?? '—'}
                                        <span className="ml-1 font-mono text-xs text-ink-faint">
                                          {item.product?.product_code}
                                        </span>
                                      </td>
                                      <td className="py-1 pr-3 font-mono text-xs">
                                        {item.batch?.batch_number ?? '—'}
                                      </td>
                                      <td className="py-1 pr-3">
                                        {item.qty} {item.unit_of_measure}
                                      </td>
                                      <td className="py-1">₹{item.declared_unit_rate.toFixed(2)}</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </div>
                        </div>
                        {c.remarks && (
                          <p className="mt-3 text-xs text-ink-muted border-t border-surface-border pt-2">
                            Remarks: {c.remarks}
                          </p>
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

      {/* New Challan Slide-Over */}
      {showSlide && (
        <NewChallanSlideOver
          onClose={() => setShowSlide(false)}
          onCreated={(challan) => {
            setChallans((prev) => [challan as Challan, ...prev]);
            setShowSlide(false);
            toast.success(`Delivery Challan ${challan.challan_no} created.`);
          }}
        />
      )}
    </div>
  );
}

// ─── New Challan Slide-Over ────────────────────────────────────────────────────
function NewChallanSlideOver({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (c: { id: string; challan_no: string; [k: string]: unknown }) => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState('');
  const [lines, setLines] = useState<FormLine[]>([
    { product_id: '', batch_id: '', unit_of_measure: '', qty: 1, declared_unit_rate: 0, remarks: '' },
  ]);

  function addLine() {
    setLines((l) => [
      ...l,
      { product_id: '', batch_id: '', unit_of_measure: '', qty: 1, declared_unit_rate: 0, remarks: '' },
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
      challan_no:              String(fd.get('challan_no') ?? ''),
      challan_date:            String(fd.get('challan_date') ?? ''),
      purpose:                 String(fd.get('purpose') ?? '') as PurposeType,
      dispatch_location_id:    String(fd.get('dispatch_location_id') ?? ''),
      bill_to_party_id:        String(fd.get('bill_to_party_id') ?? '') || null,
      ship_to_party_id:        String(fd.get('ship_to_party_id') ?? '') || null,
      consignee_name:          String(fd.get('consignee_name') ?? ''),
      consignee_gstin:         String(fd.get('consignee_gstin') ?? '') || null,
      delivery_address:        String(fd.get('delivery_address') ?? ''),
      place_of_supply_state:   String(fd.get('place_of_supply_state') ?? ''),
      transporter_id:          String(fd.get('transporter_id') ?? '') || null,
      vehicle_no:              String(fd.get('vehicle_no') ?? '') || null,
      driver_name:             String(fd.get('driver_name') ?? '') || null,
      driver_mobile:           String(fd.get('driver_mobile') ?? '') || null,
      distance_km:             Number(fd.get('distance_km') ?? 0) || null,
      eway_bill_no:            String(fd.get('eway_bill_no') ?? '') || null,
      remarks:                 String(fd.get('remarks') ?? '') || null,
      items: lines.map((l) => ({
        product_id:        l.product_id,
        batch_id:          l.batch_id,
        unit_of_measure:   l.unit_of_measure,
        qty:               Number(l.qty),
        declared_unit_rate: Number(l.declared_unit_rate),
        remarks:           l.remarks || null,
      })),
    };

    startTransition(async () => {
      const res = await createDeliveryChallan(input);
      if (res.success && res.data) {
        onCreated(res.data as { id: string; challan_no: string });
      } else {
        setError(res.error ?? 'Failed to create challan');
      }
    });
  }

  return (
    <>
      {/* Overlay */}
      <div className="fixed inset-0 bg-black/50 z-40 animate-fade-in" onClick={onClose} aria-hidden />
      {/* Panel */}
      <div className="fixed inset-y-0 right-0 z-50 w-[680px] max-w-full bg-white shadow-2xl flex flex-col animate-slide-in-right overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-border bg-surface-subtle shrink-0">
          <div>
            <h2 className="text-base font-semibold text-navy-950">New Delivery Challan</h2>
            <p className="text-xs text-ink-muted mt-0.5">
              Document stock movement — required for all transfers &gt; ₹50,000 or crossing state borders.
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

            {/* Basic Details */}
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-faint mb-3">
                Challan Details
              </h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="form-label">Challan No *</label>
                  <input name="challan_no" className="form-input" placeholder="DC-2025-001" required />
                </div>
                <div>
                  <label className="form-label">Challan Date *</label>
                  <input
                    name="challan_date"
                    type="date"
                    className="form-input"
                    defaultValue={new Date().toISOString().split('T')[0]}
                    required
                  />
                </div>
                <div className="col-span-2">
                  <label className="form-label">Purpose *</label>
                  <select name="purpose" className="form-input" required>
                    {PURPOSES.map((p) => (
                      <option key={p.value} value={p.value}>{p.label}</option>
                    ))}
                  </select>
                </div>
                <div className="col-span-2">
                  <label className="form-label">Dispatch Location ID *</label>
                  <input
                    name="dispatch_location_id"
                    className="form-input font-mono text-sm"
                    placeholder="UUID of dispatch warehouse / branch"
                    required
                  />
                </div>
              </div>
            </section>

            {/* Consignee */}
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-faint mb-3">
                Consignee &amp; Delivery
              </h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="form-label">Bill-to Party ID</label>
                  <input name="bill_to_party_id" className="form-input font-mono text-sm" placeholder="UUID (optional)" />
                </div>
                <div>
                  <label className="form-label">Ship-to Party ID</label>
                  <input name="ship_to_party_id" className="form-input font-mono text-sm" placeholder="UUID (optional)" />
                </div>
                <div>
                  <label className="form-label">Consignee Name *</label>
                  <input name="consignee_name" className="form-input" placeholder="Full legal name" required />
                </div>
                <div>
                  <label className="form-label">Consignee GSTIN</label>
                  <input name="consignee_gstin" className="form-input font-mono text-sm" placeholder="15-char GSTIN" />
                </div>
                <div className="col-span-2">
                  <label className="form-label">Delivery Address *</label>
                  <textarea name="delivery_address" className="form-input" rows={2} placeholder="Full delivery address" required />
                </div>
                <div className="col-span-2">
                  <label className="form-label">Place of Supply State *</label>
                  <input name="place_of_supply_state" className="form-input" placeholder="Maharashtra / Gujarat…" required />
                </div>
              </div>
            </section>

            {/* Transporter */}
            <section>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-faint mb-3">
                Transporter &amp; E-Way Bill
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
                  <input name="driver_name" className="form-input" placeholder="Driver full name" />
                </div>
                <div>
                  <label className="form-label">Driver Mobile</label>
                  <input name="driver_mobile" className="form-input" placeholder="+91 98765 43210" />
                </div>
                <div>
                  <label className="form-label">Distance (km)</label>
                  <input name="distance_km" type="number" min={0} step={1} className="form-input" placeholder="0" />
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
                  Challan Items *
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
                          value={line.batch_id}
                          onChange={(e) => updateLine(i, 'batch_id', e.target.value)}
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
                        <label className="form-label text-xs">Quantity *</label>
                        <input
                          type="number"
                          min={0.001}
                          step={0.001}
                          value={line.qty}
                          onChange={(e) => updateLine(i, 'qty', Number(e.target.value))}
                          className="form-input text-sm"
                          required
                        />
                      </div>
                      <div>
                        <label className="form-label text-xs">Declared Rate (₹) *</label>
                        <input
                          type="number"
                          min={0}
                          step={0.01}
                          value={line.declared_unit_rate}
                          onChange={(e) => updateLine(i, 'declared_unit_rate', Number(e.target.value))}
                          className="form-input text-sm"
                          required
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
              {isPending ? 'Creating…' : 'Issue Challan'}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
