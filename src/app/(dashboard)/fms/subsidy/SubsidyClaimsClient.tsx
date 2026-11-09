"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, X, Landmark } from "lucide-react";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import {
  createSubsidyClaim, submitSubsidyClaim, recordSubsidyReceipt, rejectSubsidyClaim, cancelSubsidyClaim, getSubsidyClaimDetail,
} from "@/actions/subsidy";
import type { SubsidyClaim, SubsidyOverview, ClaimSale, ClaimReceipt, BankAccountOption, ClaimStatus } from "@/actions/subsidy";

const STATUS_BADGE: Record<ClaimStatus, string> = {
  DRAFT: "badge-gray", SUBMITTED: "badge-info", PARTIALLY_RECEIVED: "badge-warning",
  FULLY_RECEIVED: "badge-success", REJECTED: "badge-danger", CANCELLED: "badge-gray",
};
const TYPE_LABEL: Record<string, string> = { NEEM_COATED_UREA: "Neem-coated urea", NBS_FERTILIZER: "NBS fertiliser", STATE_SUBSIDY: "State subsidy" };
const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10); };

type Props = { overview: SubsidyOverview; claims: SubsidyClaim[]; banks: BankAccountOption[] };

export default function SubsidyClaimsClient({ overview, claims, banks }: Props) {
  const router = useRouter();
  const [pending, start] = useTransition();

  const [showNew, setShowNew] = useState(false);
  const [nf, setNf] = useState({ from: monthStart(), to: today(), type: "NEEM_COATED_UREA", scheme: "" });

  const [open, setOpen] = useState<SubsidyClaim | null>(null);
  const [detail, setDetail] = useState<{ sales: ClaimSale[]; receipts: ClaimReceipt[] } | null>(null);
  const [mode, setMode] = useState<"" | "submit" | "receipt" | "reject">("");
  const [submitForm, setSubmitForm] = useState({ date: today(), ref: "" });
  const [rcForm, setRcForm] = useState({ amount: "", date: today(), account: "", ref: "" });
  const [reason, setReason] = useState("");

  async function openClaim(c: SubsidyClaim) {
    setOpen(c); setDetail(null); setMode("");
    setRcForm({ amount: String(Number(c.subsidy_pending) || ""), date: today(), account: "", ref: "" });
    try { setDetail(await getSubsidyClaimDetail(c.id)); } catch (e) { toast.error(e instanceof Error ? e.message : "Could not load the claim"); }
  }

  function done(msg: string) { toast.success(msg); setOpen(null); setShowNew(false); setMode(""); router.refresh(); }
  function fail(msg?: string) { toast.error(msg ?? "Something went wrong"); }

  const create = () => start(async () => {
    const r = await createSubsidyClaim({ periodFrom: nf.from, periodTo: nf.to, subsidyType: nf.type as "NEEM_COATED_UREA", schemeName: nf.scheme });
    if (!r.success) return fail(r.error);
    done(`Claim ${r.claim.claim_number} created for ${formatCurrency(Number(r.claim.total_subsidy_claimed))}.`);
  });
  const submit = () => open && start(async () => {
    const r = await submitSubsidyClaim(open.id, submitForm.date, submitForm.ref);
    if (r.success) done(`${open.claim_number} submitted.`); else fail(r.error);
  });
  const receive = () => open && start(async () => {
    const r = await recordSubsidyReceipt({ claimId: open.id, amount: Number(rcForm.amount), date: rcForm.date, accountId: rcForm.account, reference: rcForm.ref });
    if (r.success) done("Receipt recorded and posted to the books."); else fail(r.error);
  });
  const reject = () => open && start(async () => {
    const r = await rejectSubsidyClaim(open.id, reason);
    if (r.success) done(`${open.claim_number} marked rejected; its sales can be claimed again.`); else fail(r.error);
  });
  const cancel = () => open && start(async () => {
    const r = await cancelSubsidyClaim(open.id);
    if (r.success) done(`${open.claim_number} cancelled.`); else fail(r.error);
  });

  const canReceive = open && ["SUBMITTED", "PARTIALLY_RECEIVED"].includes(open.claim_status);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="stat-card"><p className="stat-label">Not yet claimed</p><p className="stat-value">{formatCurrency(overview.unclaimedAmount)}</p>
          <p className="stat-sub">{overview.unclaimedSales} posted sale(s)</p></div>
        <div className="stat-card"><p className="stat-label">Claimed, awaiting money</p><p className="stat-value">{formatCurrency(overview.awaitingReceipt)}</p></div>
        <div className="stat-card"><p className="stat-label">Received so far</p><p className="stat-value">{formatCurrency(overview.receivedTotal)}</p></div>
        <div className="stat-card"><p className="stat-label">Total receivable</p>
          <p className="stat-value">{formatCurrency(overview.unclaimedAmount + overview.awaitingReceipt)}</p><p className="stat-sub">Should equal account 1040</p></div>
      </div>

      <div className="card">
        <div className="p-4 flex items-center justify-between border-b border-surface-border">
          <h2 className="text-sm font-semibold">Subsidy claims</h2>
          <button onClick={() => setShowNew(true)} className="btn-primary flex items-center gap-2" disabled={overview.unclaimedSales === 0}
            title={overview.unclaimedSales === 0 ? "No unclaimed subsidised sales" : undefined}><Plus className="w-4 h-4" />New claim</button>
        </div>
        <div className="overflow-x-auto">
          {claims.length === 0 ? (
            <div className="p-12 text-center"><Landmark className="w-8 h-8 text-ink-faint mx-auto mb-3" strokeWidth={1.5} />
              <p className="text-ink-muted font-medium">No claims yet</p>
              <p className="text-sm text-ink-faint mt-1">Posted subsidised sales appear as &quot;not yet claimed&quot;. Create a claim to group them for the government.</p></div>
          ) : (
            <table className="data-table">
              <thead><tr><th>Claim</th><th>Period</th><th>Type</th><th className="text-right">Sales</th><th className="text-right">Claimed</th><th className="text-right">Received</th><th className="text-right">Pending</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {claims.map((c) => (
                  <tr key={c.id}>
                    <td><div className="font-mono text-sm text-leaf-700">{c.claim_number}</div><div className="text-xs text-ink-faint">{c.government_ref_no ?? ""}</div></td>
                    <td className="text-sm">{formatDate(c.period_from)} – {formatDate(c.period_to)}</td>
                    <td className="text-sm">{TYPE_LABEL[c.subsidy_type] ?? c.subsidy_type}</td>
                    <td className="text-right font-mono text-sm">{c.sale_count}</td>
                    <td className="text-right font-mono text-sm">{formatCurrency(Number(c.total_subsidy_claimed))}</td>
                    <td className="text-right font-mono text-sm text-leaf-700">{formatCurrency(Number(c.subsidy_received))}</td>
                    <td className={cn("text-right font-mono text-sm", Number(c.subsidy_pending) > 0 && ["SUBMITTED", "PARTIALLY_RECEIVED"].includes(c.claim_status) && "text-danger-600")}>{formatCurrency(Number(c.subsidy_pending))}</td>
                    <td><span className={cn("badge text-2xs", STATUS_BADGE[c.claim_status])}>{c.claim_status.replace(/_/g, " ")}</span></td>
                    <td className="text-right"><button onClick={() => openClaim(c)} className="btn-ghost text-xs">Open</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {showNew && (
        <>
          <div className="fixed inset-0 bg-black/50 z-40" onClick={() => setShowNew(false)} aria-hidden />
          <div className="fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-white rounded-xl shadow-xl p-6 space-y-3">
            <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">New subsidy claim</h2>
              <button onClick={() => setShowNew(false)} className="p-1.5 hover:bg-surface-border rounded-lg" aria-label="Close"><X className="w-5 h-5" /></button></div>
            <p className="text-sm text-ink-muted">Collects all posted, unclaimed sales of this subsidy type in the period.</p>
            {overview.unclaimedByType.length > 0 && (
              <p className="text-xs text-ink-faint">Unclaimed: {overview.unclaimedByType.map((t) => `${TYPE_LABEL[t.type] ?? t.type} ${formatCurrency(t.amount)} (${t.sales})`).join(" · ")}</p>)}
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-ink-muted">From *<input type="date" className="form-input w-full" value={nf.from} onChange={(e) => setNf({ ...nf, from: e.target.value })} /></label>
              <label className="text-xs text-ink-muted">To *<input type="date" className="form-input w-full" value={nf.to} onChange={(e) => setNf({ ...nf, to: e.target.value })} /></label>
            </div>
            <label className="text-xs text-ink-muted block">Subsidy type *
              <select className="form-input w-full" value={nf.type} onChange={(e) => setNf({ ...nf, type: e.target.value })}>
                {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
            <label className="text-xs text-ink-muted block">Scheme / notification<input className="form-input w-full" value={nf.scheme} onChange={(e) => setNf({ ...nf, scheme: e.target.value })} /></label>
            <div className="flex justify-end gap-2 pt-2"><button onClick={() => setShowNew(false)} className="btn-ghost">Cancel</button>
              <button onClick={create} disabled={pending} className="btn-primary disabled:opacity-50">{pending ? "Creating…" : "Create claim"}</button></div>
          </div>
        </>
      )}

      {open && (
        <>
          <div className="fixed inset-0 bg-black/50 z-40" onClick={() => setOpen(null)} aria-hidden />
          <div className="fixed right-0 top-0 h-full w-full max-w-3xl bg-white z-50 shadow-xl p-6 overflow-y-auto space-y-5">
            <div className="flex items-start justify-between">
              <div><h2 className="text-lg font-semibold">{open.claim_number}</h2>
                <p className="text-sm text-ink-muted">{TYPE_LABEL[open.subsidy_type] ?? open.subsidy_type} · {formatDate(open.period_from)} – {formatDate(open.period_to)}
                  {open.government_ref_no ? ` · Ref ${open.government_ref_no}` : ""}</p></div>
              <button onClick={() => setOpen(null)} className="p-1.5 hover:bg-surface-border rounded-lg" aria-label="Close"><X className="w-5 h-5" /></button>
            </div>
            <div className="grid grid-cols-3 gap-3 text-sm">
              <div className="stat-card"><p className="stat-label">Claimed</p><p className="stat-value text-lg">{formatCurrency(Number(open.total_subsidy_claimed))}</p></div>
              <div className="stat-card"><p className="stat-label">Received</p><p className="stat-value text-lg">{formatCurrency(Number(open.subsidy_received))}</p></div>
              <div className="stat-card"><p className="stat-label">Pending</p><p className="stat-value text-lg">{formatCurrency(Number(open.subsidy_pending))}</p></div>
            </div>
            {open.rejection_reason && <p className="text-sm text-danger-600">Rejected: {open.rejection_reason}</p>}

            <div className="flex flex-wrap gap-2">
              {open.claim_status === "DRAFT" && <>
                <button onClick={() => setMode("submit")} className="btn-primary">Submit to government</button>
                <button onClick={cancel} disabled={pending} className="btn-ghost text-danger-600">Cancel draft</button></>}
              {canReceive && <button onClick={() => setMode("receipt")} className="btn-primary">Record receipt</button>}
              {open.claim_status === "SUBMITTED" && <button onClick={() => setMode("reject")} className="btn-ghost text-danger-600">Mark rejected</button>}
            </div>

            {mode === "submit" && (
              <div className="border border-surface-border rounded-lg p-4 space-y-3 bg-surface-subtle">
                <div className="grid grid-cols-2 gap-3">
                  <label className="text-xs text-ink-muted">Submitted on *<input type="date" max={today()} className="form-input w-full" value={submitForm.date} onChange={(e) => setSubmitForm({ ...submitForm, date: e.target.value })} /></label>
                  <label className="text-xs text-ink-muted">Government ref no<input className="form-input w-full" value={submitForm.ref} onChange={(e) => setSubmitForm({ ...submitForm, ref: e.target.value })} /></label>
                </div>
                <p className="text-xs text-ink-faint">The sales in this claim become &quot;Subsidy claimed&quot; and can no longer be cancelled.</p>
                <button onClick={submit} disabled={pending} className="btn-primary disabled:opacity-50">Confirm submission</button>
              </div>)}

            {mode === "receipt" && (
              <div className="border border-surface-border rounded-lg p-4 space-y-3 bg-surface-subtle">
                <div className="grid grid-cols-2 gap-3">
                  <label className="text-xs text-ink-muted">Amount received *<input type="number" step="0.01" min="0" className="form-input w-full" value={rcForm.amount} onChange={(e) => setRcForm({ ...rcForm, amount: e.target.value })} /></label>
                  <label className="text-xs text-ink-muted">Date *<input type="date" max={today()} className="form-input w-full" value={rcForm.date} onChange={(e) => setRcForm({ ...rcForm, date: e.target.value })} /></label>
                  <label className="text-xs text-ink-muted">Received into<select className="form-input w-full" value={rcForm.account} onChange={(e) => setRcForm({ ...rcForm, account: e.target.value })}>
                    <option value="">Bank account (default)</option>{banks.map((b) => <option key={b.id} value={b.id}>{b.account_code} — {b.account_name}</option>)}</select></label>
                  <label className="text-xs text-ink-muted">UTR / reference<input className="form-input w-full" value={rcForm.ref} onChange={(e) => setRcForm({ ...rcForm, ref: e.target.value })} /></label>
                </div>
                <p className="text-xs text-ink-faint">Posts Bank (debit) / Subsidy Receivable (credit). You can receive in instalments; the claim closes when the full amount is in.</p>
                <button onClick={receive} disabled={pending || !Number(rcForm.amount)} className="btn-primary disabled:opacity-50">Post receipt</button>
              </div>)}

            {mode === "reject" && (
              <div className="border border-surface-border rounded-lg p-4 space-y-3 bg-surface-subtle">
                <label className="text-xs text-ink-muted block">Reason given by the government *<textarea rows={2} className="form-input w-full" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
                <p className="text-xs text-ink-faint">The sales return to &quot;Posted&quot; and can go into a new claim. The receivable stays on the books until written off or recovered.</p>
                <button onClick={reject} disabled={pending || !reason.trim()} className="btn-primary disabled:opacity-50">Confirm rejection</button>
              </div>)}

            <div>
              <h3 className="text-sm font-semibold mb-2">Receipts</h3>
              {!detail ? <p className="text-sm text-ink-muted">Loading…</p> : detail.receipts.length === 0 ? <p className="text-sm text-ink-muted">No money received yet.</p> : (
                <table className="data-table"><thead><tr><th>Date</th><th>Reference</th><th className="text-right">Amount</th></tr></thead>
                  <tbody>{detail.receipts.map((r) => <tr key={r.id}><td className="text-sm">{formatDate(r.receipt_date)}</td><td className="font-mono text-xs">{r.reference_no ?? "—"}</td>
                    <td className="text-right font-mono text-sm">{formatCurrency(Number(r.amount))}</td></tr>)}</tbody></table>)}
            </div>

            <div>
              <h3 className="text-sm font-semibold mb-2">Sales in this claim ({detail?.sales.length ?? open.sale_count})</h3>
              {detail && (
                <table className="data-table"><thead><tr><th>Sale</th><th>Date</th><th>Farmer</th><th>PoS ID</th><th className="text-right">Qty</th><th className="text-right">Subsidy</th><th>Status</th></tr></thead>
                  <tbody>{detail.sales.map((s) => <tr key={s.id}>
                    <td className="font-mono text-sm text-leaf-700">{s.sale_number}</td><td className="text-sm">{formatDate(s.sale_date)}</td><td className="text-sm">{s.farmer_name}</td>
                    <td className="font-mono text-xs">{s.pos_transaction_id ?? "—"}</td><td className="text-right font-mono text-sm">{Number(s.qty_sold)}</td>
                    <td className="text-right font-mono text-sm">{formatCurrency(Number(s.total_subsidy_amount))}</td>
                    <td><span className="badge badge-info text-2xs">{s.status.replace(/_/g, " ")}</span></td></tr>)}</tbody></table>)}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
