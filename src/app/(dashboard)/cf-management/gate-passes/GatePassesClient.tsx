"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { X, Printer, ShieldCheck } from "lucide-react";
import { cn, formatDate, formatDateTime } from "@/lib/utils";
import { issueGatePass, voidGatePass } from "@/actions/gate-passes";
import type { GatePassRow, PendingPassRow, PassType } from "@/actions/gate-passes";

const PASS_LABEL: Record<PassType, string> = {
  OUTWARD_SALE: "Outward — sale", OUTWARD_TRANSFER: "Outward — transfer", OUTWARD_RETURN: "Outward — return",
  INWARD_PURCHASE: "Inward — purchase", INWARD_TRANSFER: "Inward — transfer", INWARD_SALES_RETURN: "Inward — sales return",
};
const DOC_LABEL: Record<string, string> = {
  STOCK_TRANSFER: "Stock transfer", SALE_INVOICE: "Sales invoice", PURCHASE_INVOICE: "Purchase invoice",
  CREDIT_NOTE: "Credit note", DELIVERY_CHALLAN: "Delivery challan",
};

/** Opens a print-ready gate pass. All values are inserted as text nodes (never HTML), so free-text fields cannot inject markup. */
function printPass(g: GatePassRow) {
  const w = window.open("", "_blank", "width=720,height=800");
  if (!w) { toast.error("Allow pop-ups to print the gate pass."); return; }
  const d = w.document;
  d.title = `Gate Pass ${g.gate_pass_no}`;
  const style = d.createElement("style");
  style.textContent = "body{font-family:Arial,sans-serif;margin:32px}h1{font-size:20px;margin:0}table{border-collapse:collapse;width:100%;margin-top:16px}td{border:1px solid #333;padding:8px;font-size:14px}td:first-child{width:32%;font-weight:bold;background:#f3f3f3}.sig{display:flex;justify-content:space-between;margin-top:64px;font-size:13px}.void{color:#b00;font-weight:bold;margin-top:8px}";
  d.head.appendChild(style);
  const h1 = d.createElement("h1"); h1.textContent = `GATE PASS — ${PASS_LABEL[g.pass_type].toUpperCase()}`; d.body.appendChild(h1);
  if (g.is_voided) { const v = d.createElement("div"); v.className = "void"; v.textContent = `VOIDED: ${g.void_reason ?? ""}`; d.body.appendChild(v); }
  const rows: [string, string][] = [
    ["Gate pass no", g.gate_pass_no], ["Date / time", formatDateTime(g.pass_date)], ["Gate / location", g.location_name],
    ["Against", `${DOC_LABEL[g.reference_doc_type] ?? g.reference_doc_type} ${g.reference_doc_no}`],
    ["Vehicle no", g.vehicle_no], ["Driver", g.driver_name ?? "—"], ["Driver mobile", g.driver_mobile ?? "—"],
    ["Total packages", g.total_packages === null ? "—" : String(g.total_packages)], ["Security officer", g.security_officer_name ?? "—"],
    ["Remarks", g.remarks ?? "—"],
  ];
  const t = d.createElement("table");
  rows.forEach(([k, v]) => { const tr = d.createElement("tr"); const a = d.createElement("td"); a.textContent = k; const b = d.createElement("td"); b.textContent = v; tr.append(a, b); t.appendChild(tr); });
  d.body.appendChild(t);
  const sig = d.createElement("div"); sig.className = "sig";
  ["Security officer", "Driver", "Store in-charge"].forEach((s) => { const x = d.createElement("div"); x.textContent = `${s}: ____________________`; sig.appendChild(x); });
  d.body.appendChild(sig);
  w.focus();
  w.print();
}

type Props = { passes: GatePassRow[]; pending: PendingPassRow[] };

export default function GatePassesClient({ passes, pending }: Props) {
  const router = useRouter();
  const [tab, setTab] = useState<"pending" | "issued">(pending.length > 0 ? "pending" : "issued");
  const [search, setSearch] = useState("");
  const [target, setTarget] = useState<PendingPassRow | null>(null);
  const [f, setF] = useState({ vehicle: "", driver: "", mobile: "", packages: "", officer: "", remarks: "" });
  const [voiding, setVoiding] = useState<GatePassRow | null>(null);
  const [reason, setReason] = useState("");
  const [pendingTx, start] = useTransition();

  const q = search.trim().toLowerCase();
  const passList = passes.filter((g) => !q || `${g.gate_pass_no} ${g.reference_doc_no} ${g.vehicle_no} ${g.driver_name ?? ""}`.toLowerCase().includes(q));
  const pendList = pending.filter((p) => !q || `${p.reference_doc_no} ${p.counterparty ?? ""} ${p.location_name}`.toLowerCase().includes(q));

  function begin(p: PendingPassRow) { setTarget(p); setF({ vehicle: "", driver: "", mobile: "", packages: "", officer: "", remarks: "" }); }

  function issue() {
    if (!target) return;
    start(async () => {
      const res = await issueGatePass({
        referenceType: target.reference_doc_type, referenceId: target.reference_doc_id, passType: target.pass_type,
        vehicleNo: f.vehicle, driverName: f.driver, driverMobile: f.mobile,
        totalPackages: f.packages.trim() === "" ? undefined : Math.round(Number(f.packages)),
        securityOfficer: f.officer, remarks: f.remarks,
      });
      if (!res.success) { toast.error(res.error); return; }
      toast.success(`Gate pass ${res.gatePassNo} issued.`);
      setTarget(null); setTab("issued"); router.refresh();
    });
  }

  function doVoid() {
    if (!voiding) return;
    start(async () => {
      const res = await voidGatePass(voiding.id, reason);
      if (!res.success) { toast.error(res.error); return; }
      toast.success(`${voiding.gate_pass_no} voided. A new pass can be issued for the document.`);
      setVoiding(null); setReason(""); router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="card p-4 flex flex-wrap items-center gap-3">
        <div className="flex gap-2">
          {([["pending", `To issue (${pending.length})`], ["issued", `Issued (${passes.length})`]] as const).map(([k, label]) => (
            <button key={k} onClick={() => setTab(k)}
              className={cn("px-3 py-1.5 rounded-full text-xs font-medium border", tab === k ? "bg-leaf-600 text-white border-leaf-600" : "bg-surface-subtle text-ink-muted border-surface-border")}>{label}</button>
          ))}
        </div>
        <input type="search" className="form-input text-sm w-full sm:w-72 ml-auto" placeholder="Search pass, document, vehicle, driver…" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>

      {tab === "pending" ? (
        <div className="card overflow-x-auto">
          <div className="p-4 border-b border-surface-border text-sm text-ink-muted">Movements from the last 60 days that have no gate pass yet. Passes are a record of what passed the gate — they don&apos;t block dispatch.</div>
          {pendList.length === 0 ? (
            <div className="p-12 text-center"><ShieldCheck className="w-8 h-8 text-leaf-600 mx-auto mb-3" strokeWidth={1.5} /><p className="text-ink-muted font-medium">Every recent movement has a gate pass</p></div>
          ) : (
            <table className="data-table">
              <thead><tr><th>Document</th><th>Date</th><th>Pass</th><th>Gate</th><th>Party / other end</th><th></th></tr></thead>
              <tbody>
                {pendList.map((p) => (
                  <tr key={`${p.reference_doc_id}-${p.pass_type}`}>
                    <td><div className="font-mono text-sm text-leaf-700">{p.reference_doc_no}</div><div className="text-xs text-ink-faint">{DOC_LABEL[p.reference_doc_type]}</div></td>
                    <td className="text-sm">{formatDate(p.doc_date)}</td>
                    <td><span className="badge badge-info text-2xs">{PASS_LABEL[p.pass_type]}</span></td>
                    <td className="text-sm">{p.location_name}</td>
                    <td className="text-sm">{p.counterparty ?? "—"}</td>
                    <td className="text-right"><button onClick={() => begin(p)} className="btn-primary text-xs px-3 py-1">Issue pass</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : (
        <div className="card overflow-x-auto">
          {passList.length === 0 ? (
            <p className="p-12 text-center text-sm text-ink-muted">No gate passes issued yet.</p>
          ) : (
            <table className="data-table">
              <thead><tr><th>Gate pass</th><th>Date / time</th><th>Type</th><th>Against</th><th>Vehicle / driver</th><th className="text-right">Pkgs</th><th></th></tr></thead>
              <tbody>
                {passList.map((g) => (
                  <tr key={g.id} className={cn(g.is_voided && "opacity-50")}>
                    <td><div className={cn("font-mono text-sm text-leaf-700", g.is_voided && "line-through")}>{g.gate_pass_no}</div><div className="text-xs text-ink-faint">{g.location_name}</div></td>
                    <td className="text-sm">{formatDateTime(g.pass_date)}</td>
                    <td><span className="badge badge-info text-2xs">{PASS_LABEL[g.pass_type]}</span></td>
                    <td><div className="font-mono text-sm">{g.reference_doc_no}</div><div className="text-xs text-ink-faint">{DOC_LABEL[g.reference_doc_type]}</div></td>
                    <td><div className="font-mono text-sm">{g.vehicle_no}</div><div className="text-xs text-ink-faint">{g.driver_name ?? ""}{g.driver_mobile ? ` · ${g.driver_mobile}` : ""}</div></td>
                    <td className="text-right font-mono text-sm">{g.total_packages ?? "—"}</td>
                    <td className="text-right whitespace-nowrap">
                      {g.is_voided ? <span className="text-xs text-danger-600" title={g.void_reason ?? ""}>Voided</span> : (
                        <>
                          <button onClick={() => printPass(g)} className="btn-ghost text-xs inline-flex items-center gap-1"><Printer className="w-3 h-3" />Print</button>
                          <button onClick={() => { setVoiding(g); setReason(""); }} className="btn-ghost text-xs text-danger-600">Void</button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {target && (
        <>
          <div className="fixed inset-0 bg-black/50 z-40" onClick={() => setTarget(null)} aria-hidden />
          <div className="fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-lg max-h-[90vh] overflow-y-auto bg-white rounded-xl shadow-xl p-6 space-y-3">
            <div className="flex items-center justify-between"><h2 className="text-lg font-semibold">Issue gate pass</h2>
              <button onClick={() => setTarget(null)} className="p-1.5 hover:bg-surface-border rounded-lg" aria-label="Close"><X className="w-5 h-5" /></button></div>
            <p className="text-sm text-ink-muted">{PASS_LABEL[target.pass_type]} · {DOC_LABEL[target.reference_doc_type]} <strong>{target.reference_doc_no}</strong> · gate: {target.location_name}</p>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-ink-muted">Vehicle no *<input className="form-input w-full font-mono uppercase" placeholder="MH12AB1234" value={f.vehicle} onChange={(e) => setF({ ...f, vehicle: e.target.value })} autoFocus /></label>
              <label className="text-xs text-ink-muted">Total packages<input type="number" min="0" step="1" className="form-input w-full" value={f.packages} onChange={(e) => setF({ ...f, packages: e.target.value })} /></label>
              <label className="text-xs text-ink-muted">Driver name<input className="form-input w-full" value={f.driver} onChange={(e) => setF({ ...f, driver: e.target.value })} /></label>
              <label className="text-xs text-ink-muted">Driver mobile<input className="form-input w-full" inputMode="tel" value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value })} /></label>
            </div>
            <label className="text-xs text-ink-muted block">Security officer<input className="form-input w-full" value={f.officer} onChange={(e) => setF({ ...f, officer: e.target.value })} /></label>
            <label className="text-xs text-ink-muted block">Remarks<input className="form-input w-full" value={f.remarks} onChange={(e) => setF({ ...f, remarks: e.target.value })} /></label>
            <div className="flex justify-end gap-2 pt-1"><button onClick={() => setTarget(null)} className="btn-ghost">Cancel</button>
              <button onClick={issue} disabled={pendingTx || !f.vehicle.trim()} className="btn-primary disabled:opacity-50">{pendingTx ? "Issuing…" : "Issue gate pass"}</button></div>
          </div>
        </>
      )}

      {voiding && (
        <>
          <div className="fixed inset-0 bg-black/50 z-40" onClick={() => setVoiding(null)} aria-hidden />
          <div className="fixed z-50 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-white rounded-xl shadow-xl p-6 space-y-3">
            <h2 className="text-lg font-semibold">Void {voiding.gate_pass_no}</h2>
            <p className="text-sm text-ink-muted">The pass stays on record, marked void with your reason. You can then issue a corrected pass for {voiding.reference_doc_no}.</p>
            <textarea rows={2} className="form-input w-full" placeholder="Reason (e.g. wrong vehicle recorded)" value={reason} onChange={(e) => setReason(e.target.value)} />
            <div className="flex justify-end gap-2"><button onClick={() => setVoiding(null)} className="btn-ghost">Cancel</button>
              <button onClick={doVoid} disabled={pendingTx || !reason.trim()} className="btn-primary disabled:opacity-50">Void pass</button></div>
          </div>
        </>
      )}
    </div>
  );
}
