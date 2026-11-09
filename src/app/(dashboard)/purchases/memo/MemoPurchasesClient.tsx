"use client";

import { Fragment, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, X, Trash2, FileClock, ChevronDown, ChevronRight, AlertCircle } from "lucide-react";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import { calcMemoLine, isMemoError } from "@/lib/memo";
import {
  createMemoPurchase, postMemoPurchase, cancelMemoDraft, getMatchCandidates, settleMemo, closeMemoUnits,
} from "@/actions/memo";
import type { MemoPurchase, PendingMemoLine, PendingSupplier, MatchInvoice, JournalSuggestion } from "@/actions/memo";
import StockJournalDialog, { type JournalLookups, type JournalPrefill } from "@/components/inventory/StockJournalDialog";

const AGE_ALERT_DAYS = 30;
const today = () => new Date().toISOString().slice(0, 10);

type Party = { id: string; name: string; party_type: string };
type Product = { id: string; name: string; product_code: string | null; unit_of_measure: string };
type Location = { id: string; name: string };
type Props = {
  memos: MemoPurchase[]; pendingLines: PendingMemoLine[]; pendingSuppliers: PendingSupplier[];
  parties: Party[]; products: Product[]; locations: Location[]; journalLookups: JournalLookups;
};

const STATUS_BADGE = { DRAFT: "badge-warning", POSTED: "badge-success", CANCELLED: "badge-gray" } as const;

export default function MemoPurchasesClient({ memos, pendingLines, pendingSuppliers, parties, products, locations, journalLookups }: Props) {
  const router = useRouter();
  const [tab, setTab] = useState<"pending" | "memos">(pendingSuppliers.length > 0 ? "pending" : "memos");
  const [pendingTx, start] = useTransition();
  const [openSupplier, setOpenSupplier] = useState<string | null>(null);
  const [openMemo, setOpenMemo] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [matching, setMatching] = useState<{ memoId: string; supplierId: string; memoNo: string } | null>(null);
  const [closing, setClosing] = useState<PendingMemoLine | null>(null);
  const [journal, setJournal] = useState<JournalPrefill | null>(null);

  const suppliers = parties.filter((p) => p.party_type === "SUPPLIER" || p.party_type === "BOTH");
  const refresh = () => router.refresh();

  function post(m: MemoPurchase) {
    if (!confirm(`Post ${m.memo_no}? Stock comes in now at the memo cost (no GST) and the supplier's invoice is tracked as pending.`)) return;
    start(async () => {
      const r = await postMemoPurchase(m.id);
      if (!r.success) { toast.error(r.error); return; }
      toast.success(`${m.memo_no} posted. It now appears under Pending invoices.`); refresh();
    });
  }
  function cancel(m: MemoPurchase) {
    if (!confirm(`Cancel draft ${m.memo_no}?`)) return;
    start(async () => {
      const r = await cancelMemoDraft(m.id);
      if (!r.success) { toast.error(r.error); return; }
      toast.success(`${m.memo_no} cancelled.`); refresh();
    });
  }

  const totalPending = pendingSuppliers.reduce((s, x) => s + Number(x.pending_value), 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="stat-card"><p className="stat-label">Invoice value awaited</p><p className="stat-value">{formatCurrency(totalPending)}</p><p className="stat-sub">Should equal account 2005</p></div>
        <div className="stat-card"><p className="stat-label">Suppliers to chase</p><p className="stat-value">{pendingSuppliers.length}</p></div>
        <div className="stat-card"><p className="stat-label">Open memos</p><p className="stat-value">{pendingSuppliers.reduce((s, x) => s + Number(x.open_memos), 0)}</p></div>
        <div className="stat-card"><p className="stat-label">Waiting over {AGE_ALERT_DAYS} days</p>
          <p className={cn("stat-value", pendingSuppliers.some((s) => s.oldest_age_days > AGE_ALERT_DAYS) && "text-danger-600")}>
            {pendingSuppliers.filter((s) => s.oldest_age_days > AGE_ALERT_DAYS).length}</p></div>
      </div>

      <div className="card p-4 flex flex-wrap items-center gap-3">
        <div className="flex gap-2">
          {([["pending", `Pending invoices (${pendingSuppliers.length})`], ["memos", `All memos (${memos.length})`]] as const).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              className={cn("px-3 py-1.5 rounded-full text-xs font-medium border", tab === k ? "bg-leaf-600 text-white border-leaf-600" : "bg-surface-subtle text-ink-muted border-surface-border")}>{label}</button>))}
        </div>
        <button onClick={() => setShowNew(true)} className="btn-primary ml-auto flex items-center gap-2"><Plus className="w-4 h-4" />New memo receipt</button>
      </div>

      {tab === "pending" ? (
        <div className="card overflow-x-auto">
          <div className="p-4 border-b border-surface-border text-sm text-ink-muted">
            Goods received without an invoice. When the supplier&apos;s invoice arrives, post it as a normal purchase invoice, then <strong>Match</strong> it here.
            If the supplier billed a different product from the one delivered, you&apos;ll be offered the stock journal.
          </div>
          {pendingSuppliers.length === 0 ? (
            <div className="p-12 text-center"><FileClock className="w-8 h-8 text-ink-faint mx-auto mb-3" strokeWidth={1.5} /><p className="text-ink-muted font-medium">No invoices are awaited</p></div>
          ) : (
            <table className="data-table">
              <thead><tr><th></th><th>Supplier</th><th className="text-right">Open memos</th><th className="text-right">Units awaiting invoice</th><th className="text-right">Value</th><th>Oldest</th></tr></thead>
              <tbody>
                {pendingSuppliers.map((s) => (
                  <Fragment key={s.supplier_id}>
                    <tr className="cursor-pointer" onClick={() => setOpenSupplier(openSupplier === s.supplier_id ? null : s.supplier_id)}>
                      <td className="w-8">{openSupplier === s.supplier_id ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</td>
                      <td className="text-sm font-medium">{s.supplier_name}</td>
                      <td className="text-right font-mono text-sm">{s.open_memos}</td>
                      <td className="text-right font-mono text-sm">{Number(s.pending_units)}</td>
                      <td className="text-right font-mono text-sm">{formatCurrency(Number(s.pending_value))}</td>
                      <td className={cn("text-sm", s.oldest_age_days > AGE_ALERT_DAYS && "text-danger-600 font-semibold")}>
                        {formatDate(s.oldest_memo_date)} · {s.oldest_age_days}d{s.oldest_age_days > AGE_ALERT_DAYS && <AlertCircle className="w-3.5 h-3.5 inline ml-1" />}</td>
                    </tr>
                    {openSupplier === s.supplier_id && (
                      <tr><td></td><td colSpan={5} className="bg-surface-subtle">
                        <table className="data-table w-full">
                          <thead><tr><th>Memo / challan</th><th>Product</th><th className="text-right">Pending</th><th className="text-right">Cost</th><th className="text-right">Value</th><th>Age</th><th></th></tr></thead>
                          <tbody>
                            {pendingLines.filter((l) => l.supplier_id === s.supplier_id).map((l) => (
                              <tr key={l.memo_line_id}>
                                <td><div className="font-mono text-sm text-leaf-700">{l.memo_no}</div><div className="text-xs text-ink-faint">{l.supplier_ref} · {formatDate(l.memo_date)}</div></td>
                                <td className="text-sm">{l.product_name}</td>
                                <td className="text-right font-mono text-sm">{Number(l.pending_units)} {l.unit_of_measure}</td>
                                <td className="text-right font-mono text-sm">{Number(l.unit_cost)}</td>
                                <td className="text-right font-mono text-sm">{formatCurrency(Number(l.pending_value))}</td>
                                <td className={cn("text-sm", l.age_days > AGE_ALERT_DAYS && "text-danger-600")}>{l.age_days}d</td>
                                <td className="text-right whitespace-nowrap">
                                  <button onClick={() => setMatching({ memoId: l.memo_id, supplierId: l.supplier_id, memoNo: l.memo_no })} className="btn-primary text-xs px-3 py-1">Match invoice</button>
                                  <button onClick={() => setClosing(l)} className="btn-ghost text-xs">Return / waive</button>
                                </td>
                              </tr>))}
                          </tbody>
                        </table>
                      </td></tr>
                    )}
                  </Fragment>))}
              </tbody>
            </table>
          )}
        </div>
      ) : (
        <div className="card overflow-x-auto">
          {memos.length === 0 ? <p className="p-12 text-center text-sm text-ink-muted">No memo receipts yet.</p> : (
            <table className="data-table">
              <thead><tr><th></th><th>Memo</th><th>Date</th><th>Supplier</th><th>Challan / ref</th><th className="text-right">Value</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {memos.map((m) => {
                  const pend = m.lines.reduce((s, l) => s + Number(l.pending_units), 0);
                  return (
                    <Fragment key={m.id}>
                      <tr>
                        <td className="w-8 cursor-pointer" onClick={() => setOpenMemo(openMemo === m.id ? null : m.id)}>{openMemo === m.id ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}</td>
                        <td className="font-mono text-sm text-leaf-700">{m.memo_no}</td>
                        <td className="text-sm">{formatDate(m.memo_date)}</td>
                        <td className="text-sm">{m.supplier?.name}</td>
                        <td className="font-mono text-xs">{m.supplier_ref}</td>
                        <td className="text-right font-mono text-sm">{m.status === "POSTED" ? formatCurrency(Number(m.total_value)) : "—"}</td>
                        <td><span className={cn("badge text-2xs", STATUS_BADGE[m.status])}>{m.status}</span>
                          {m.status === "POSTED" && <div className="text-xs text-ink-faint">{pend > 0 ? `${pend} unit(s) awaiting invoice` : "fully matched"}</div>}</td>
                        <td className="text-right whitespace-nowrap">
                          {m.status === "DRAFT" && <><button onClick={() => post(m)} disabled={pendingTx} className="btn-primary text-xs px-3 py-1">Post</button>
                            <button onClick={() => cancel(m)} disabled={pendingTx} className="btn-ghost text-xs text-danger-600">Cancel</button></>}
                        </td>
                      </tr>
                      {openMemo === m.id && (
                        <tr><td></td><td colSpan={7} className="bg-surface-subtle">
                          <table className="data-table w-full">
                            <thead><tr><th>#</th><th>Product</th><th className="text-right">Qty + free</th><th className="text-right">Rate</th><th className="text-right">Discount</th><th className="text-right">Net</th><th className="text-right">Cost/unit</th><th className="text-right">Matched / returned / waived</th></tr></thead>
                            <tbody>{m.lines.map((l) => (
                              <tr key={l.id}>
                                <td className="text-xs">{l.line_no}</td><td className="text-sm">{l.product?.name}{l.batch_number ? ` · ${l.batch_number}` : ""}</td>
                                <td className="text-right font-mono text-sm">{Number(l.qty)}{Number(l.free_qty) > 0 ? ` + ${Number(l.free_qty)}` : ""}</td>
                                <td className="text-right font-mono text-sm">{Number(l.rate)}</td>
                                <td className="text-right font-mono text-sm">{Number(l.discount_percent) > 0 ? `${Number(l.discount_percent)}%` : ""}{Number(l.discount_amount) > 0 ? ` −${Number(l.discount_amount)}` : ""}</td>
                                <td className="text-right font-mono text-sm">{l.net_amount !== null ? formatCurrency(Number(l.net_amount)) : "—"}</td>
                                <td className="text-right font-mono text-sm">{l.unit_cost !== null ? Number(l.unit_cost) : "—"}</td>
                                <td className="text-right font-mono text-sm">{Number(l.settled_units)} / {Number(l.returned_units)} / {Number(l.waived_units)}</td>
                              </tr>))}</tbody>
                          </table>
                        </td></tr>)}
                    </Fragment>);
                })}
              </tbody>
            </table>)}
        </div>
      )}

      {showNew && <NewMemoDialog suppliers={suppliers} products={products} locations={locations} onClose={() => setShowNew(false)}
        onDone={(no) => { setShowNew(false); toast.success(`${no} saved as a draft. Review it and post it to bring the stock in.`); setTab("memos"); refresh(); }} />}

      {matching && <MatchDialog target={matching} lines={pendingLines.filter((l) => l.memo_id === matching.memoId)}
        onClose={() => setMatching(null)}
        onDone={(res) => {
          setMatching(null); refresh();
          if (res.suggestions.length > 0) {
            toast.message("The supplier billed a different product from the one delivered. Review and post the stock journal to correct your stock.");
            setJournal({
              locationId: res.suggestions[0].locationId,
              reason: `Billed as ${res.suggestions.map((s) => s.outProductName).join(", ")} against physical ${res.suggestions.map((s) => s.inProductName).join(", ")} (memo ${matching.memoNo})`,
              out: res.suggestions.map((s) => ({ batchId: s.outBatchId, qty: s.qty })),
              in: res.suggestions.map((s) => ({ productId: s.inProductId, qty: s.qty })),
              memoSettlementId: res.settlementId, purchaseInvoiceId: res.invoiceId,
            });
          } else toast.success("Memo matched to the supplier's invoice.");
        }} />}

      {closing && <CloseDialog line={closing} onClose={() => setClosing(null)} onDone={() => { setClosing(null); refresh(); }} />}

      {journal && <StockJournalDialog lookups={journalLookups} prefill={journal} onClose={() => { setJournal(null); refresh(); }}
        onDone={() => { setJournal(null); refresh(); }} />}
    </div>
  );
}

// ─── New memo ────────────────────────────────────────────────

type FormLine = { product_id: string; qty: string; free_qty: string; rate: string; pct: string; flat: string; batch: string };
const emptyLine = (): FormLine => ({ product_id: "", qty: "", free_qty: "", rate: "", pct: "", flat: "", batch: "" });

function NewMemoDialog({ suppliers, products, locations, onClose, onDone }: {
  suppliers: Party[]; products: Product[]; locations: Location[]; onClose: () => void; onDone: (memoNo: string) => void;
}) {
  const [f, setF] = useState({ supplier: "", location: "", date: today(), ref: "", narration: "" });
  const [lines, setLines] = useState<FormLine[]>([emptyLine()]);
  const [pending, start] = useTransition();

  const calc = lines.map((l) => calcMemoLine({ qty: Number(l.qty), freeQty: Number(l.free_qty) || 0, rate: Number(l.rate), discountPercent: Number(l.pct) || 0, discountAmount: Number(l.flat) || 0 }));
  const total = calc.reduce((s, r) => s + (isMemoError(r) ? 0 : r.net), 0);
  const upd = (i: number, k: keyof FormLine, v: string) => setLines(lines.map((x, j) => (j === i ? { ...x, [k]: v } : x)));

  const problems: string[] = [];
  if (!f.supplier) problems.push("Select the supplier");
  if (!f.location) problems.push("Select the receiving location");
  if (!f.ref.trim()) problems.push("Enter the supplier's challan / reference number");
  lines.forEach((l, i) => {
    if (!l.product_id) problems.push(`Line ${i + 1}: select a product`);
    else if (l.qty === "" || l.rate === "") problems.push(`Line ${i + 1}: enter quantity and rate`);
    else if (isMemoError(calc[i])) problems.push(`Line ${i + 1}: ${(calc[i] as { error: string }).error}`);
  });

  function save() {
    start(async () => {
      const res = await createMemoPurchase({
        supplier_id: f.supplier, received_at_location: f.location, memo_date: f.date, supplier_ref: f.ref, narration: f.narration,
        lines: lines.map((l) => ({ product_id: l.product_id, qty: Number(l.qty), free_qty: Number(l.free_qty) || 0, rate: Number(l.rate),
          discount_percent: Number(l.pct) || 0, discount_amount: Number(l.flat) || 0, batch_number: l.batch })),
      });
      if (!res.success) { toast.error(res.error); return; }
      onDone(res.memoNo);
    });
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} aria-hidden />
      <div className="fixed right-0 top-0 h-full w-full max-w-3xl bg-white z-50 shadow-xl p-6 overflow-y-auto space-y-4">
        <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">New memo receipt</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-surface-border rounded-lg" aria-label="Close"><X className="w-5 h-5" /></button></div>
        <p className="text-sm text-ink-muted">Goods received without an invoice. Stock comes in at <strong>rate less discount</strong> with <strong>no GST</strong>; the supplier&apos;s invoice is then tracked as pending.</p>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs text-ink-muted">Supplier *<select className="form-input w-full" value={f.supplier} onChange={(e) => setF({ ...f, supplier: e.target.value })}>
            <option value="">Select…</option>{suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label className="text-xs text-ink-muted">Received at *<select className="form-input w-full" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })}>
            <option value="">Select…</option>{locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
          <label className="text-xs text-ink-muted">Receipt date *<input type="date" max={today()} className="form-input w-full" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></label>
          <label className="text-xs text-ink-muted">Supplier challan / ref no *<input className="form-input w-full font-mono" value={f.ref} onChange={(e) => setF({ ...f, ref: e.target.value })} /></label>
        </div>
        <label className="text-xs text-ink-muted block">Narration<input className="form-input w-full" value={f.narration} onChange={(e) => setF({ ...f, narration: e.target.value })} /></label>

        <div className="space-y-2">
          <div className="grid grid-cols-12 gap-2 text-xs text-ink-muted px-1"><span className="col-span-3">Product *</span><span className="col-span-1 text-right">Qty</span><span className="col-span-1 text-right">Free</span>
            <span className="col-span-2 text-right">Rate</span><span className="col-span-1 text-right">Disc %</span><span className="col-span-1 text-right">Disc ₹</span><span className="col-span-2 text-right">Net / unit cost</span></div>
          {lines.map((l, i) => {
            const r = calc[i];
            return (
              <div key={i} className="grid grid-cols-12 gap-2 items-center">
                <select className="form-input col-span-3" value={l.product_id} onChange={(e) => upd(i, "product_id", e.target.value)}>
                  <option value="">Select…</option>{products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
                <input type="number" min="0" step="0.001" className="form-input col-span-1 text-right" value={l.qty} onChange={(e) => upd(i, "qty", e.target.value)} />
                <input type="number" min="0" step="0.001" className="form-input col-span-1 text-right" value={l.free_qty} onChange={(e) => upd(i, "free_qty", e.target.value)} />
                <input type="number" min="0" step="0.01" className="form-input col-span-2 text-right" value={l.rate} onChange={(e) => upd(i, "rate", e.target.value)} />
                <input type="number" min="0" max="100" step="0.01" className="form-input col-span-1 text-right" value={l.pct} onChange={(e) => upd(i, "pct", e.target.value)} />
                <input type="number" min="0" step="0.01" className="form-input col-span-1 text-right" value={l.flat} onChange={(e) => upd(i, "flat", e.target.value)} />
                <div className="col-span-2 flex items-center justify-end gap-1 text-xs font-mono">
                  {isMemoError(r) || l.qty === "" || l.rate === "" ? <span className="text-ink-faint">—</span> : <span>{formatCurrency(r.net)} · {r.unitCost}</span>}
                  <button onClick={() => setLines(lines.length > 1 ? lines.filter((_, j) => j !== i) : lines)} className="p-1 hover:bg-surface-border rounded" aria-label="Remove line"><Trash2 className="w-3.5 h-3.5 text-ink-faint" /></button>
                </div>
                <input placeholder="Batch no (optional — auto if blank)" className="form-input col-span-12 text-xs" value={l.batch} onChange={(e) => upd(i, "batch", e.target.value)} />
              </div>);
          })}
          <button onClick={() => setLines([...lines, emptyLine()])} className="btn-ghost text-xs flex items-center gap-1"><Plus className="w-3 h-3" />Add line</button>
        </div>

        <div className="border border-surface-border rounded-lg p-3 bg-surface-subtle text-sm flex justify-between"><span>Total memo value (no GST)</span><strong>{formatCurrency(total)}</strong></div>
        {problems.length > 0 && <ul className="text-sm text-danger-600 list-disc ml-5">{problems.slice(0, 5).map((p) => <li key={p}>{p}</li>)}</ul>}
        <div className="flex gap-2"><button onClick={save} disabled={pending || problems.length > 0} className="btn-primary disabled:opacity-50">{pending ? "Saving…" : "Save as draft"}</button>
          <button onClick={onClose} className="btn-ghost">Cancel</button></div>
      </div>
    </>
  );
}

// ─── Match to the supplier's invoice ─────────────────────────

function MatchDialog({ target, lines, onClose, onDone }: {
  target: { memoId: string; supplierId: string; memoNo: string }; lines: PendingMemoLine[]; onClose: () => void;
  onDone: (r: { settlementId: string; invoiceId: string; suggestions: JournalSuggestion[] }) => void;
}) {
  const [invoices, setInvoices] = useState<MatchInvoice[] | null>(null);
  const [invoiceId, setInvoiceId] = useState("");
  const [picks, setPicks] = useState<Record<string, { invoiceLineId: string; units: string }>>({});
  const [notes, setNotes] = useState("");
  const [pending, start] = useTransition();

  useEffect(() => {
    getMatchCandidates(target.supplierId).then(setInvoices).catch((e) => { toast.error(e instanceof Error ? e.message : "Could not load invoices"); setInvoices([]); });
  }, [target.supplierId]);

  const invoice = invoices?.find((i) => i.id === invoiceId);

  function chooseInvoice(id: string) {
    setInvoiceId(id);
    const inv = invoices?.find((i) => i.id === id);
    const next: typeof picks = {};
    const used = new Set<string>();
    for (const l of lines) {
      const cand = inv?.lines.find((il) => il.unmatched_units > 0 && !used.has(il.id) && il.product_id === l.product_id)
        ?? inv?.lines.find((il) => il.unmatched_units > 0 && !used.has(il.id));
      if (cand) { used.add(cand.id); next[l.memo_line_id] = { invoiceLineId: cand.id, units: String(Math.min(Number(l.pending_units), cand.unmatched_units)) }; }
    }
    setPicks(next);
  }

  const chosen = lines.filter((l) => picks[l.memo_line_id]?.invoiceLineId && Number(picks[l.memo_line_id].units) > 0);
  const problems: string[] = [];
  if (!invoiceId) problems.push("Choose the supplier's invoice");
  if (invoiceId && chosen.length === 0) problems.push("Choose at least one line to match");
  chosen.forEach((l) => {
    const pk = picks[l.memo_line_id];
    const il = invoice?.lines.find((x) => x.id === pk.invoiceLineId);
    if (Number(pk.units) > Number(l.pending_units)) problems.push(`${l.product_name}: only ${Number(l.pending_units)} pending on the memo`);
    if (il && Number(pk.units) > il.unmatched_units) problems.push(`${l.product_name}: only ${il.unmatched_units} unmatched on that invoice line`);
  });

  function go() {
    start(async () => {
      const res = await settleMemo({
        memoId: target.memoId, invoiceId, notes,
        lines: chosen.map((l) => ({ memoLineId: l.memo_line_id, invoiceLineId: picks[l.memo_line_id].invoiceLineId, units: Number(picks[l.memo_line_id].units) })),
      });
      if (!res.success) { toast.error(res.error); return; }
      onDone(res);
    });
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} aria-hidden />
      <div className="fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-3xl max-h-[90vh] overflow-y-auto bg-white rounded-xl shadow-xl p-6 space-y-4">
        <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">Match {target.memoNo} to the supplier&apos;s invoice</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-surface-border rounded-lg" aria-label="Close"><X className="w-5 h-5" /></button></div>
        <p className="text-sm text-ink-muted">The invoice must already be posted under Purchases → Purchase Invoices, exactly as the supplier billed it.</p>
        {invoices === null ? <p className="text-sm text-ink-muted">Loading invoices…</p> : invoices.length === 0 ? (
          <p className="text-sm text-danger-600">This supplier has no posted invoice with unmatched quantity. Post the supplier&apos;s invoice first.</p>
        ) : (
          <label className="text-xs text-ink-muted block">Supplier invoice *
            <select className="form-input w-full" value={invoiceId} onChange={(e) => chooseInvoice(e.target.value)}>
              <option value="">Select…</option>{invoices.map((i) => <option key={i.id} value={i.id}>{i.invoice_number}{i.supplier_invoice_no ? ` (${i.supplier_invoice_no})` : ""} · {formatDate(i.invoice_date)}</option>)}</select></label>)}

        {invoice && (
          <table className="data-table">
            <thead><tr><th>Memo line (received)</th><th className="text-right">Pending</th><th>Invoice line (billed)</th><th className="text-right">Units to match</th></tr></thead>
            <tbody>
              {lines.map((l) => {
                const pk = picks[l.memo_line_id] ?? { invoiceLineId: "", units: "" };
                const il = invoice.lines.find((x) => x.id === pk.invoiceLineId);
                return (
                  <tr key={l.memo_line_id}>
                    <td><div className="text-sm">{l.product_name}</div><div className="text-xs text-ink-faint">cost {Number(l.unit_cost)}</div></td>
                    <td className="text-right font-mono text-sm">{Number(l.pending_units)}</td>
                    <td>
                      <select className="form-input w-full" value={pk.invoiceLineId} onChange={(e) => setPicks({ ...picks, [l.memo_line_id]: { invoiceLineId: e.target.value, units: pk.units } })}>
                        <option value="">Don&apos;t match this line</option>
                        {invoice.lines.filter((x) => x.unmatched_units > 0).map((x) => <option key={x.id} value={x.id}>{x.product_name} · {x.unmatched_units} unmatched @ {x.unit_cost}</option>)}</select>
                      {il && il.product_id !== l.product_id && <p className="text-xs text-gold-700 mt-1">Billed as <strong>{il.product_name}</strong>, received as <strong>{l.product_name}</strong> — a stock journal will be offered next.</p>}
                    </td>
                    <td className="text-right"><input type="number" min="0" step="0.001" className="form-input w-24 text-right" value={pk.units} disabled={!pk.invoiceLineId}
                      onChange={(e) => setPicks({ ...picks, [l.memo_line_id]: { ...pk, units: e.target.value } })} /></td>
                  </tr>);
              })}
            </tbody>
          </table>)}

        <label className="text-xs text-ink-muted block">Notes<input className="form-input w-full" value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
        <p className="text-xs text-ink-faint">Matching clears the pending liability at memo cost and takes the memo stock back out of the ledger (units already sold have their cost difference booked to cost of goods).</p>
        {problems.length > 0 && invoiceId !== "" && <ul className="text-sm text-danger-600 list-disc ml-5">{problems.slice(0, 4).map((p) => <li key={p}>{p}</li>)}</ul>}
        <div className="flex justify-end gap-2"><button onClick={onClose} className="btn-ghost">Cancel</button>
          <button onClick={go} disabled={pending || problems.length > 0} className="btn-primary disabled:opacity-50">{pending ? "Matching…" : "Match to invoice"}</button></div>
      </div>
    </>
  );
}

// ─── Return / waive ──────────────────────────────────────────

function CloseDialog({ line, onClose, onDone }: { line: PendingMemoLine; onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<"RETURN" | "WAIVED">("RETURN");
  const [units, setUnits] = useState(String(Number(line.pending_units)));
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();

  function go() {
    start(async () => {
      const res = await closeMemoUnits({ memoLineId: line.memo_line_id, units: Number(units), mode, reason });
      if (!res.success) { toast.error(res.error); return; }
      toast.success(mode === "RETURN" ? "Goods returned and the liability cleared." : "Supplier's invoice waived — the liability was released to other income.");
      onDone();
    });
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} aria-hidden />
      <div className="fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-white rounded-xl shadow-xl p-6 space-y-3">
        <h2 className="text-lg font-semibold">Close memo units</h2>
        <p className="text-sm text-ink-muted">{line.memo_no} · {line.product_name} · {Number(line.pending_units)} pending</p>
        <div className="flex gap-2">
          {(["RETURN", "WAIVED"] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)} className={cn("flex-1 px-3 py-2 rounded-lg text-sm border", mode === m ? "bg-leaf-600 text-white border-leaf-600" : "bg-surface-subtle border-surface-border")}>
              {m === "RETURN" ? "Return to supplier" : "Supplier waives invoice"}</button>))}
        </div>
        <p className="text-xs text-ink-faint">{mode === "RETURN"
          ? "Stock goes back to the supplier and the pending liability is cleared. Only units still on hand can be returned."
          : "The goods stay in your stock at memo cost and the pending liability is released to Other Income."}</p>
        <label className="text-xs text-ink-muted block">Units<input type="number" min="0" step="0.001" className="form-input w-full" value={units} onChange={(e) => setUnits(e.target.value)} /></label>
        <label className="text-xs text-ink-muted block">Reason *<input className="form-input w-full" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <div className="flex justify-end gap-2"><button onClick={onClose} className="btn-ghost">Cancel</button>
          <button onClick={go} disabled={pending || !(Number(units) > 0) || reason.trim().length < 3} className="btn-primary disabled:opacity-50">{pending ? "Saving…" : "Confirm"}</button></div>
      </div>
    </>
  );
}
