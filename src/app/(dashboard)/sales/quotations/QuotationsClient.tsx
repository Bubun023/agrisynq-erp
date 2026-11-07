"use client";

import { useState, useTransition } from "react";
import { Plus, Search, X, Trash2, FileText } from "lucide-react";
import { formatDate, formatCurrency } from "@/lib/utils";
import { toast } from "sonner";
import { createQuotation } from "@/actions/sales-orders";

// ─── Types ────────────────────────────────────────────────────────────────────

type QuotationStatus =
  | "DRAFT"
  | "SENT"
  | "ACCEPTED"
  | "REJECTED"
  | "EXPIRED"
  | "CONVERTED";

interface Quotation {
  id: string;
  quotation_number: string;
  quotation_date: string;
  valid_until: string | null;
  status: QuotationStatus;
  customer_id: string;
  customer_name: string;
  customer_phone: string | null;
  parties: { name: string } | null;
  total_taxable_amount: number;
  total_gst_amount: number;
  total_amount: number;
  created_at: string;
}

interface LineItem {
  product_id: string;
  description: string;
  ordered_qty: number | "";
  unit_of_measure: string;
  unit_price: number | "";
  discount_percent: number | "";
  gst_rate: number | "";
}

const EMPTY_LINE: LineItem = {
  product_id: "",
  description: "",
  ordered_qty: "",
  unit_of_measure: "KG",
  unit_price: "",
  discount_percent: 0,
  gst_rate: 18,
};

// ─── Status config ─────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<QuotationStatus, string> = {
  DRAFT: "Draft",
  SENT: "Sent",
  ACCEPTED: "Accepted",
  REJECTED: "Rejected",
  EXPIRED: "Expired",
  CONVERTED: "Converted",
};

const statusBadgeClass = (status: QuotationStatus): string => {
  switch (status) {
    case "DRAFT":
      return "badge badge-warning";
    case "SENT":
      return "badge badge-info";
    case "ACCEPTED":
      return "badge badge-success";
    case "REJECTED":
      return "badge badge-danger";
    case "EXPIRED":
      return "badge badge-danger";
    case "CONVERTED":
      return "badge bg-navy-950 text-white border border-navy-900";
    default:
      return "badge";
  }
};

const FILTER_PILLS: { label: string; value: QuotationStatus | "ALL" }[] = [
  { label: "All", value: "ALL" },
  { label: "Draft", value: "DRAFT" },
  { label: "Sent", value: "SENT" },
  { label: "Accepted", value: "ACCEPTED" },
  { label: "Rejected", value: "REJECTED" },
  { label: "Expired", value: "EXPIRED" },
  { label: "Converted", value: "CONVERTED" },
];

// ─── Validity helpers ──────────────────────────────────────────────────────────

function validUntilClass(valid_until: string | null, status: QuotationStatus): string {
  if (!valid_until || status === "EXPIRED" || status === "REJECTED" || status === "CONVERTED") {
    return "text-ink-faint";
  }
  const today = new Date();
  const expiry = new Date(valid_until);
  const diffDays = Math.ceil((expiry.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays < 0) return "text-red-600 font-medium";
  if (diffDays <= 7) return "text-amber-600 font-medium";
  return "text-ink-muted";
}

// ─── Line item math ────────────────────────────────────────────────────────────

function calcLine(item: LineItem) {
  const qty = Number(item.ordered_qty) || 0;
  const price = Number(item.unit_price) || 0;
  const disc = Number(item.discount_percent) || 0;
  const gst = Number(item.gst_rate) || 0;
  const taxable = qty * price * (1 - disc / 100);
  const gstAmt = taxable * (gst / 100);
  return { taxable, gstAmt, total: taxable + gstAmt };
}

function calcTotals(lines: LineItem[]) {
  return lines.reduce(
    (acc, l) => {
      const { taxable, gstAmt, total } = calcLine(l);
      acc.taxable += taxable;
      acc.gst += gstAmt;
      acc.total += total;
      return acc;
    },
    { taxable: 0, gst: 0, total: 0 }
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

export default function QuotationsClient({
  initialQuotations,
}: {
  initialQuotations: Quotation[];
}) {
  const [quotations] = useState<Quotation[]>(initialQuotations);
  const [activeFilter, setActiveFilter] = useState<QuotationStatus | "ALL">("ALL");
  const [search, setSearch] = useState("");
  const [slideOpen, setSlideOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  // ── Form state ──
  const [customerId, setCustomerId] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [quotationDate, setQuotationDate] = useState(
    new Date().toISOString().slice(0, 10)
  );
  const [validUntil, setValidUntil] = useState("");
  const [referenceNo, setReferenceNo] = useState("");
  const [narration, setNarration] = useState("");
  const [lines, setLines] = useState<LineItem[]>([{ ...EMPTY_LINE }]);

  // ── Filter & search ──
  const filtered = quotations.filter((q) => {
    const matchStatus = activeFilter === "ALL" || q.status === activeFilter;
    const query = search.toLowerCase();
    const matchSearch =
      !query ||
      q.quotation_number.toLowerCase().includes(query) ||
      q.customer_name.toLowerCase().includes(query);
    return matchStatus && matchSearch;
  });

  // ── Line item helpers ──
  const updateLine = (idx: number, patch: Partial<LineItem>) => {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  };
  const addLine = () => setLines((prev) => [...prev, { ...EMPTY_LINE }]);
  const removeLine = (idx: number) =>
    setLines((prev) => prev.filter((_, i) => i !== idx));

  const totals = calcTotals(lines);

  // ── Reset form ──
  const resetForm = () => {
    setCustomerId("");
    setCustomerName("");
    setCustomerPhone("");
    setQuotationDate(new Date().toISOString().slice(0, 10));
    setValidUntil("");
    setReferenceNo("");
    setNarration("");
    setLines([{ ...EMPTY_LINE }]);
  };

  // ── Submit ──
  const handleCreate = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData();
    fd.append("customer_id", customerId);
    fd.append("customer_name", customerName);
    fd.append("customer_phone", customerPhone);
    fd.append("quotation_date", quotationDate);
    fd.append("valid_until", validUntil);
    fd.append("reference_no", referenceNo);
    fd.append("narration", narration);
    fd.append("line_items", JSON.stringify(lines));

    startTransition(async () => {
      const result = await createQuotation(undefined as never, fd);
      if (result?.error) {
        toast.error(result.error);
      } else {
        toast.success(`Quotation ${result.soNumber ?? ""} created.`);
        setSlideOpen(false);
        resetForm();
      }
    });
  };

  // ─────────────────────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="page-title">Quotations</h1>
          <p className="page-subtitle">Create and track sales quotations</p>
        </div>
        <button
          onClick={() => setSlideOpen(true)}
          className="flex items-center gap-2 rounded-lg bg-navy-950 px-4 py-2 text-sm font-medium text-white hover:bg-navy-900 transition-colors"
        >
          <Plus className="h-4 w-4" />
          New Quotation
        </button>
      </div>

      {/* Filter pills */}
      <div className="flex flex-wrap gap-2">
        {FILTER_PILLS.map((pill) => (
          <button
            key={pill.value}
            onClick={() => setActiveFilter(pill.value)}
            className={`rounded-full px-3 py-1 text-xs font-medium border transition-colors ${
              activeFilter === pill.value
                ? "bg-navy-950 text-white border-navy-950"
                : "border-surface-border text-ink-muted hover:bg-surface-subtle"
            }`}
          >
            {pill.label}
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="relative w-full max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-ink-faint" />
        <input
          type="text"
          placeholder="Search quotation no. or customer…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="w-full rounded-lg border border-surface-border bg-white py-2 pl-9 pr-4 text-sm text-ink-muted placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-navy-950/20"
        />
      </div>

      {/* Table */}
      <div className="card overflow-hidden p-0">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-20 text-ink-faint">
            <FileText className="h-10 w-10 opacity-40" />
            <p className="text-sm">No quotations found</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-surface-border bg-surface-subtle">
                  <th className="px-4 py-3 text-left font-medium text-ink-muted">Quot. No.</th>
                  <th className="px-4 py-3 text-left font-medium text-ink-muted">Date</th>
                  <th className="px-4 py-3 text-left font-medium text-ink-muted">Valid Until</th>
                  <th className="px-4 py-3 text-left font-medium text-ink-muted">Customer</th>
                  <th className="px-4 py-3 text-right font-medium text-ink-muted">Total</th>
                  <th className="px-4 py-3 text-center font-medium text-ink-muted">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {filtered.map((q) => (
                  <tr key={q.id} className="hover:bg-surface-subtle transition-colors">
                    <td className="px-4 py-3 font-mono text-xs text-leaf-700">
                      {q.quotation_number}
                    </td>
                    <td className="px-4 py-3 text-ink-muted">{formatDate(q.quotation_date)}</td>
                    <td className={`px-4 py-3 ${validUntilClass(q.valid_until, q.status)}`}>
                      {q.valid_until ? formatDate(q.valid_until) : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-ink-muted">{q.customer_name}</div>
                      {q.customer_phone && (
                        <div className="text-xs text-ink-faint">{q.customer_phone}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-medium text-ink-muted">
                      {formatCurrency(q.total_amount)}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={statusBadgeClass(q.status)}>
                        {STATUS_LABELS[q.status]}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Slide-over ── */}
      {/* Backdrop */}
      {slideOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm"
          onClick={() => setSlideOpen(false)}
        />
      )}

      {/* Panel */}
      <aside
        className={`fixed right-0 top-0 z-50 h-full w-[680px] max-w-full bg-white shadow-xl flex flex-col transform transition-transform duration-300 ${
          slideOpen ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* Panel header */}
        <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
          <h2 className="text-base font-semibold text-ink-muted">New Quotation</h2>
          <button
            onClick={() => { setSlideOpen(false); resetForm(); }}
            className="rounded p-1 hover:bg-surface-subtle transition-colors"
          >
            <X className="h-5 w-5 text-ink-faint" />
          </button>
        </div>

        {/* Scrollable form body */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          <form id="quot-form" onSubmit={handleCreate} className="space-y-6">

            {/* Customer */}
            <section>
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-faint">
                Customer Details
              </h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="form-label">Customer ID (UUID)</label>
                  <input
                    type="text"
                    required
                    placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                    value={customerId}
                    onChange={(e) => setCustomerId(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-surface-border px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-navy-950/20"
                  />
                </div>
                <div>
                  <label className="form-label">Customer Name</label>
                  <input
                    type="text"
                    required
                    placeholder="Full name"
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-950/20"
                  />
                </div>
                <div className="col-span-2">
                  <label className="form-label">Phone</label>
                  <input
                    type="tel"
                    placeholder="+91 9876543210"
                    value={customerPhone}
                    onChange={(e) => setCustomerPhone(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-950/20"
                  />
                </div>
              </div>
            </section>

            {/* Quotation details */}
            <section>
              <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-ink-faint">
                Quotation Details
              </h3>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="form-label">Quotation Date</label>
                  <input
                    type="date"
                    required
                    value={quotationDate}
                    onChange={(e) => setQuotationDate(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-950/20"
                  />
                </div>
                <div>
                  <label className="form-label">Valid Until</label>
                  <input
                    type="date"
                    value={validUntil}
                    onChange={(e) => setValidUntil(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-950/20"
                  />
                </div>
                <div>
                  <label className="form-label">Reference No.</label>
                  <input
                    type="text"
                    value={referenceNo}
                    onChange={(e) => setReferenceNo(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-950/20"
                  />
                </div>
                <div>
                  <label className="form-label">Narration</label>
                  <input
                    type="text"
                    value={narration}
                    onChange={(e) => setNarration(e.target.value)}
                    className="mt-1 w-full rounded-lg border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-950/20"
                  />
                </div>
              </div>
            </section>

            {/* Line items */}
            <section>
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-ink-faint">
                  Line Items
                </h3>
                <button
                  type="button"
                  onClick={addLine}
                  className="flex items-center gap-1 text-xs font-medium text-leaf-700 hover:text-leaf-600"
                >
                  <Plus className="h-3.5 w-3.5" /> Add Line
                </button>
              </div>

              <div className="space-y-3">
                {lines.map((line, idx) => {
                  const { taxable, gstAmt, total } = calcLine(line);
                  return (
                    <div
                      key={idx}
                      className="rounded-lg border border-surface-border bg-surface-subtle p-3"
                    >
                      <div className="mb-2 grid grid-cols-2 gap-2">
                        <div>
                          <label className="form-label text-[10px]">Product ID (UUID)</label>
                          <input
                            type="text"
                            required
                            placeholder="Product UUID"
                            value={line.product_id}
                            onChange={(e) => updateLine(idx, { product_id: e.target.value })}
                            className="mt-0.5 w-full rounded border border-surface-border bg-white px-2 py-1.5 text-xs font-mono focus:outline-none focus:ring-1 focus:ring-navy-950/20"
                          />
                        </div>
                        <div>
                          <label className="form-label text-[10px]">Description</label>
                          <input
                            type="text"
                            placeholder="Product description"
                            value={line.description}
                            onChange={(e) => updateLine(idx, { description: e.target.value })}
                            className="mt-0.5 w-full rounded border border-surface-border bg-white px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-navy-950/20"
                          />
                        </div>
                      </div>
                      <div className="grid grid-cols-5 gap-2">
                        <div>
                          <label className="form-label text-[10px]">Qty</label>
                          <input
                            type="number"
                            required
                            min={0}
                            step="0.001"
                            value={line.ordered_qty}
                            onChange={(e) =>
                              updateLine(idx, {
                                ordered_qty: e.target.value === "" ? "" : Number(e.target.value),
                              })
                            }
                            className="mt-0.5 w-full rounded border border-surface-border bg-white px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-navy-950/20"
                          />
                        </div>
                        <div>
                          <label className="form-label text-[10px]">UOM</label>
                          <input
                            type="text"
                            value={line.unit_of_measure}
                            onChange={(e) => updateLine(idx, { unit_of_measure: e.target.value })}
                            className="mt-0.5 w-full rounded border border-surface-border bg-white px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-navy-950/20"
                          />
                        </div>
                        <div>
                          <label className="form-label text-[10px]">Unit Price (₹)</label>
                          <input
                            type="number"
                            required
                            min={0}
                            step="0.01"
                            value={line.unit_price}
                            onChange={(e) =>
                              updateLine(idx, {
                                unit_price: e.target.value === "" ? "" : Number(e.target.value),
                              })
                            }
                            className="mt-0.5 w-full rounded border border-surface-border bg-white px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-navy-950/20"
                          />
                        </div>
                        <div>
                          <label className="form-label text-[10px]">Disc %</label>
                          <input
                            type="number"
                            min={0}
                            max={100}
                            step="0.01"
                            value={line.discount_percent}
                            onChange={(e) =>
                              updateLine(idx, {
                                discount_percent: e.target.value === "" ? "" : Number(e.target.value),
                              })
                            }
                            className="mt-0.5 w-full rounded border border-surface-border bg-white px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-navy-950/20"
                          />
                        </div>
                        <div>
                          <label className="form-label text-[10px]">GST %</label>
                          <input
                            type="number"
                            min={0}
                            max={100}
                            step="0.01"
                            value={line.gst_rate}
                            onChange={(e) =>
                              updateLine(idx, {
                                gst_rate: e.target.value === "" ? "" : Number(e.target.value),
                              })
                            }
                            className="mt-0.5 w-full rounded border border-surface-border bg-white px-2 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-navy-950/20"
                          />
                        </div>
                      </div>
                      <div className="mt-2 flex items-center justify-between">
                        <div className="flex gap-4 text-[11px] text-ink-faint">
                          <span>
                            Taxable:{" "}
                            <span className="font-medium text-ink-muted">
                              {formatCurrency(taxable)}
                            </span>
                          </span>
                          <span>
                            GST:{" "}
                            <span className="font-medium text-ink-muted">
                              {formatCurrency(gstAmt)}
                            </span>
                          </span>
                          <span>
                            Line Total:{" "}
                            <span className="font-semibold text-leaf-700">
                              {formatCurrency(total)}
                            </span>
                          </span>
                        </div>
                        {lines.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeLine(idx)}
                            className="text-red-400 hover:text-red-600 transition-colors"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* Live totals */}
            <section className="rounded-lg border border-surface-border bg-navy-950/5 px-4 py-3">
              <div className="flex items-center justify-between text-sm">
                <span className="text-ink-faint">Taxable Amount</span>
                <span className="font-medium text-ink-muted">{formatCurrency(totals.taxable)}</span>
              </div>
              <div className="mt-1 flex items-center justify-between text-sm">
                <span className="text-ink-faint">Total GST</span>
                <span className="font-medium text-ink-muted">{formatCurrency(totals.gst)}</span>
              </div>
              <div className="mt-2 flex items-center justify-between border-t border-surface-border pt-2">
                <span className="font-semibold text-ink-muted">Quotation Total</span>
                <span className="text-lg font-bold text-leaf-700">{formatCurrency(totals.total)}</span>
              </div>
            </section>

          </form>
        </div>

        {/* Panel footer */}
        <div className="flex items-center justify-end gap-3 border-t border-surface-border px-6 py-4">
          <button
            type="button"
            onClick={() => { setSlideOpen(false); resetForm(); }}
            className="rounded-lg border border-surface-border px-4 py-2 text-sm font-medium text-ink-muted hover:bg-surface-subtle transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="quot-form"
            disabled={isPending}
            className="rounded-lg bg-navy-950 px-5 py-2 text-sm font-medium text-white hover:bg-navy-900 transition-colors disabled:opacity-50"
          >
            {isPending ? "Creating…" : "Create Quotation"}
          </button>
        </div>
      </aside>
    </div>
  );
}
