"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Upload, FileSpreadsheet, AlertCircle, CheckCircle2, X } from "lucide-react";
import { cn, formatCurrency, formatDate, formatDateTime } from "@/lib/utils";
import { parseCsv } from "@/lib/csv";
import { mapColumns, buildLines, FIELD_LABEL, REQUIRED_FIELDS, type FmsField, type ImportLine } from "@/lib/fms-import";
import { importFmsData, getFmsImportDetail } from "@/actions/fms";
import type { FmsImportBatch, FmsImportLine, FmsMissingInPortal, ImportMatchStatus } from "@/actions/fms";

const STATUS_LABEL: Record<ImportMatchStatus | "MISSING_IN_PORTAL", string> = {
  MATCHED: "Matched",
  QTY_MISMATCH: "Quantity differs",
  SUBSIDY_MISMATCH: "Subsidy differs",
  MISSING_IN_SYSTEM: "Not in system",
  CANCELLED_IN_SYSTEM: "Cancelled here, live on portal",
  NOT_POSTED: "Sale not posted",
  DUPLICATE_IN_FILE: "Duplicate in file",
  INVALID: "No PoS ID",
  MISSING_IN_PORTAL: "In system, not on portal",
};
const STATUS_BADGE: Record<string, string> = {
  MATCHED: "badge-success",
  QTY_MISMATCH: "badge-danger",
  SUBSIDY_MISMATCH: "badge-danger",
  MISSING_IN_SYSTEM: "badge-danger",
  CANCELLED_IN_SYSTEM: "badge-danger",
  NOT_POSTED: "badge-warning",
  DUPLICATE_IN_FILE: "badge-warning",
  INVALID: "badge-warning",
  MISSING_IN_PORTAL: "badge-danger",
};

const monthStart = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10); };
const today = () => new Date().toISOString().slice(0, 10);

type Parsed = {
  filename: string;
  lines: ImportLine[];
  errors: { row: number; message: string }[];
  missing: FmsField[];
  mapped: FmsField[];
  headers: string[];
};

export default function FmsImportClient({ initialBatches }: { initialBatches: FmsImportBatch[] }) {
  const [batches, setBatches] = useState(initialBatches);
  const [dealer, setDealer] = useState("");
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [fileError, setFileError] = useState("");
  const [pending, start] = useTransition();

  const [openBatch, setOpenBatch] = useState<FmsImportBatch | null>(null);
  const [detail, setDetail] = useState<{ lines: FmsImportLine[]; missingInPortal: FmsMissingInPortal[] } | null>(null);
  const [filter, setFilter] = useState<string>("EXCEPTIONS");

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    setFileError(""); setParsed(null);
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { setFileError("File is larger than 10 MB."); return; }
    if (!/\.(csv|txt|tsv)$/i.test(file.name)) { setFileError("Please upload a .csv file (export the portal report as CSV)."); return; }
    const text = await file.text();
    const rows = parseCsv(text);
    if (rows.length < 2) { setFileError("The file has no data rows."); return; }
    const cm = mapColumns(rows[0]);
    const { lines, errors } = cm.missing.length ? { lines: [], errors: [] } : buildLines(rows, cm);
    setParsed({
      filename: file.name, lines, errors, missing: cm.missing, headers: rows[0],
      mapped: (Object.keys(cm.map) as FmsField[]),
    });
  }

  function runImport() {
    if (!parsed) return;
    start(async () => {
      const res = await importFmsData({ filename: parsed.filename, dealerId: dealer, periodFrom: from, periodTo: to, lines: parsed.lines });
      if (!res.success) { toast.error(res.error); return; }
      setBatches((p) => [res.batch, ...p]);
      setParsed(null);
      const b = res.batch;
      toast.success(`Imported ${b.total_lines} lines — ${b.matched} matched, ${b.mismatched + b.missing_in_system + b.cancelled_in_system + b.missing_in_portal} need attention.`);
      void view(b);
    });
  }

  async function view(b: FmsImportBatch) {
    setOpenBatch(b); setDetail(null); setFilter("EXCEPTIONS");
    try { setDetail(await getFmsImportDetail(b.id)); }
    catch (err) { toast.error(err instanceof Error ? err.message : "Could not load the import"); setOpenBatch(null); }
  }

  const canImport = !!parsed && parsed.missing.length === 0 && parsed.errors.length === 0 && parsed.lines.length > 0 && dealer.trim() && from && to && to >= from;

  const shownLines = (detail?.lines ?? []).filter((l) =>
    filter === "ALL" ? true : filter === "EXCEPTIONS" ? l.match_status !== "MATCHED" : l.match_status === filter);

  return (
    <div className="space-y-6">
      <div className="card p-5 space-y-4">
        <h2 className="text-sm font-semibold flex items-center gap-2"><Upload className="w-4 h-4" />Import portal transactions</h2>
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          <label className="text-xs text-ink-muted">FMS dealer ID *<input className="form-input w-full" value={dealer} onChange={(e) => setDealer(e.target.value)} /></label>
          <label className="text-xs text-ink-muted">Period from *<input type="date" className="form-input w-full" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="text-xs text-ink-muted">Period to *<input type="date" className="form-input w-full" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          <label className="text-xs text-ink-muted">CSV file *<input type="file" accept=".csv,.tsv,.txt,text/csv" className="form-input w-full text-sm" onChange={onFile} /></label>
        </div>

        {fileError && <p className="text-sm text-danger-600 flex items-center gap-2"><AlertCircle className="w-4 h-4" />{fileError}</p>}

        {parsed && (
          <div className="border border-surface-border rounded-lg p-4 space-y-3 bg-surface-subtle">
            <p className="text-sm font-medium flex items-center gap-2"><FileSpreadsheet className="w-4 h-4" />{parsed.filename}</p>
            <div className="flex flex-wrap gap-2 text-xs">
              {(Object.keys(FIELD_LABEL) as FmsField[]).map((f) => (
                <span key={f} className={cn("badge", parsed.mapped.includes(f) ? "badge-success" : REQUIRED_FIELDS.includes(f) ? "badge-danger" : "badge-gray")}>
                  {FIELD_LABEL[f]}: {parsed.mapped.includes(f) ? "found" : REQUIRED_FIELDS.includes(f) ? "MISSING" : "not in file"}
                </span>
              ))}
            </div>
            {parsed.missing.length > 0 && (
              <p className="text-sm text-danger-600">
                Could not find a column for: {parsed.missing.map((m) => FIELD_LABEL[m]).join(", ")}. Columns in your file: {parsed.headers.join(" | ")}.
                Rename the header(s) (e.g. &quot;PoS Transaction ID&quot;, &quot;Quantity&quot;, &quot;Subsidy Amount&quot;) and upload again.
              </p>
            )}
            {parsed.errors.length > 0 && (
              <div className="text-sm text-danger-600">
                <p className="font-medium">{parsed.errors.length} row(s) have problems — fix the file and upload again (nothing is imported until the file is clean):</p>
                <ul className="list-disc ml-5 mt-1">{parsed.errors.slice(0, 8).map((er) => <li key={er.row}>Row {er.row}: {er.message}</li>)}</ul>
                {parsed.errors.length > 8 && <p className="mt-1">…and {parsed.errors.length - 8} more.</p>}
              </div>
            )}
            {parsed.missing.length === 0 && parsed.errors.length === 0 && (
              <p className="text-sm text-leaf-700 flex items-center gap-2"><CheckCircle2 className="w-4 h-4" />{parsed.lines.length} transactions read and ready to match.</p>
            )}
            <button onClick={runImport} disabled={!canImport || pending} className="btn-primary disabled:opacity-50">
              {pending ? "Matching…" : "Import & match"}
            </button>
          </div>
        )}
      </div>

      <div className="card">
        <div className="p-4 border-b border-surface-border"><h2 className="text-sm font-semibold">Import history</h2></div>
        <div className="overflow-x-auto">
          {batches.length === 0 ? (
            <p className="p-10 text-center text-sm text-ink-muted">No imports yet. Download the transaction report from the FMS portal as CSV and upload it above.</p>
          ) : (
            <table className="data-table">
              <thead><tr><th>Imported</th><th>File</th><th>Dealer</th><th>Period</th><th className="text-right">Lines</th><th className="text-right">Matched</th><th className="text-right">Need attention</th><th></th></tr></thead>
              <tbody>
                {batches.map((b) => {
                  const attention = b.mismatched + b.missing_in_system + b.cancelled_in_system + b.not_posted + b.missing_in_portal;
                  return (
                    <tr key={b.id}>
                      <td className="text-sm">{formatDateTime(b.created_at)}</td>
                      <td className="text-sm">{b.filename ?? "—"}</td>
                      <td className="font-mono text-xs">{b.fms_dealer_id}</td>
                      <td className="text-sm">{formatDate(b.period_from)} – {formatDate(b.period_to)}</td>
                      <td className="text-right font-mono text-sm">{b.total_lines}</td>
                      <td className="text-right font-mono text-sm text-leaf-700">{b.matched}</td>
                      <td className={cn("text-right font-mono text-sm", attention > 0 && "text-danger-600 font-semibold")}>{attention}</td>
                      <td className="text-right"><button onClick={() => view(b)} className="btn-ghost text-xs">View</button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {openBatch && (
        <>
          <div className="fixed inset-0 bg-black/50 z-40" onClick={() => setOpenBatch(null)} aria-hidden />
          <div className="fixed right-0 top-0 h-full w-full max-w-4xl bg-white z-50 shadow-xl p-6 overflow-y-auto space-y-4">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-lg font-semibold">{openBatch.filename ?? "Import"}</h2>
                <p className="text-sm text-ink-muted">Dealer {openBatch.fms_dealer_id} · {formatDate(openBatch.period_from)} – {formatDate(openBatch.period_to)}</p>
              </div>
              <button onClick={() => setOpenBatch(null)} className="p-1.5 hover:bg-surface-border rounded-lg" aria-label="Close"><X className="w-5 h-5" /></button>
            </div>

            <div className="flex flex-wrap gap-2">
              {([
                ["EXCEPTIONS", "All exceptions"],
                ["ALL", "All lines"],
                ["MATCHED", `Matched (${openBatch.matched})`],
                ["QTY_MISMATCH", "Quantity differs"],
                ["SUBSIDY_MISMATCH", "Subsidy differs"],
                ["MISSING_IN_SYSTEM", `Not in system (${openBatch.missing_in_system})`],
                ["CANCELLED_IN_SYSTEM", `Cancelled here (${openBatch.cancelled_in_system})`],
                ["NOT_POSTED", `Not posted (${openBatch.not_posted})`],
                ["DUPLICATE_IN_FILE", `Duplicates (${openBatch.duplicate_in_file})`],
                ["INVALID", `No PoS ID (${openBatch.invalid_lines})`],
                ["MISSING_IN_PORTAL", `In system, not on portal (${openBatch.missing_in_portal})`],
              ] as [string, string][]).map(([k, label]) => (
                <button key={k} onClick={() => setFilter(k)}
                  className={cn("px-3 py-1.5 rounded-full text-xs font-medium border", filter === k ? "bg-leaf-600 text-white border-leaf-600" : "bg-surface-subtle text-ink-muted border-surface-border")}>
                  {label}
                </button>
              ))}
            </div>

            {!detail ? <p className="text-sm text-ink-muted">Loading…</p> : filter === "MISSING_IN_PORTAL" ? (
              <table className="data-table">
                <thead><tr><th>Sale No</th><th>Date</th><th>Farmer</th><th>PoS ID</th><th className="text-right">Qty</th><th className="text-right">Subsidy</th><th>Status</th></tr></thead>
                <tbody>
                  {detail.missingInPortal.length === 0 && <tr><td colSpan={7} className="text-center text-sm text-ink-muted py-6">Every posted sale in this period appears in the portal file.</td></tr>}
                  {detail.missingInPortal.map((s) => (
                    <tr key={s.sale_id}>
                      <td className="font-mono text-sm text-leaf-700">{s.sale_number}</td><td className="text-sm">{formatDate(s.sale_date)}</td>
                      <td className="text-sm">{s.farmer_name}</td><td className="font-mono text-xs">{s.pos_transaction_id ?? "—"}</td>
                      <td className="text-right font-mono text-sm">{Number(s.qty_sold)}</td><td className="text-right font-mono text-sm">{formatCurrency(Number(s.total_subsidy_amount))}</td>
                      <td><span className="badge badge-info text-2xs">{s.status.replace(/_/g, " ")}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <table className="data-table">
                <thead><tr><th>#</th><th>PoS ID</th><th>Farmer</th><th className="text-right">Qty (portal / system)</th><th className="text-right">Subsidy (portal / system)</th><th>Result</th></tr></thead>
                <tbody>
                  {shownLines.length === 0 && <tr><td colSpan={6} className="text-center text-sm text-ink-muted py-6">Nothing in this view.</td></tr>}
                  {shownLines.map((l) => (
                    <tr key={l.id}>
                      <td className="text-xs text-ink-faint">{l.line_no}</td>
                      <td className="font-mono text-xs">{l.pos_transaction_id ?? "—"}</td>
                      <td className="text-sm">{l.farmer_name ?? "—"}</td>
                      <td className="text-right font-mono text-sm">{l.qty ?? "—"} / {l.system_qty ?? "—"}</td>
                      <td className="text-right font-mono text-sm">{l.subsidy_amount !== null ? formatCurrency(Number(l.subsidy_amount)) : "—"} / {l.system_subsidy !== null ? formatCurrency(Number(l.system_subsidy)) : "—"}</td>
                      <td>
                        <span className={cn("badge text-2xs", STATUS_BADGE[l.match_status])}>{STATUS_LABEL[l.match_status]}</span>
                        {l.note && <div className="text-xs text-ink-faint mt-1 max-w-[280px]">{l.note}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
}
