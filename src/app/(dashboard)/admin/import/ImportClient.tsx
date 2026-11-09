"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Download, Upload, CheckCircle2, AlertTriangle, FileSpreadsheet } from "lucide-react";
import { getEntity, parseImportFile, templateCsv, type ImportEntity, type ParsedImport } from "@/lib/data-import";
import { importMasterData, importOpeningBalances, type MasterImportResult, type OpeningResult } from "@/actions/data-import";

const MASTER: ImportEntity[] = ["locations", "parties", "products", "farmers"];
const OPENING: ImportEntity[] = ["opening_stock", "opening_parties", "opening_accounts"];
const inr = (n: number) => n.toLocaleString("en-IN", { style: "currency", currency: "INR" });

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}

function IssueList({ issues }: { issues: { row: number; message: string; sheet?: string }[] }) {
  if (!issues.length) return null;
  return (
    <div className="mt-3 max-h-64 overflow-auto rounded border border-red-200 bg-red-50 text-sm">
      <table className="w-full"><tbody>
        {issues.slice(0, 300).map((i, k) => (
          <tr key={k} className="border-b border-red-100 last:border-0">
            <td className="px-3 py-1.5 whitespace-nowrap text-red-700">{i.sheet ? `${i.sheet} · ` : ""}{i.row > 0 ? `line ${i.row}` : "file"}</td>
            <td className="px-3 py-1.5 text-red-900">{i.message}</td>
          </tr>
        ))}
      </tbody></table>
      {issues.length > 300 && <div className="px-3 py-1.5 text-red-700">…and {issues.length - 300} more</div>}
    </div>
  );
}

function FilePicker({ onText, label }: { onText: (name: string, text: string) => void; label: string }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm hover:bg-slate-50">
      <Upload size={16} /> {label}
      <input type="file" accept=".csv,text/csv" className="hidden"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (f) onText(f.name, await f.text());
          e.target.value = "";
        }} />
    </label>
  );
}

function MasterPanel({ entity }: { entity: ImportEntity }) {
  const def = getEntity(entity)!;
  const [file, setFile] = useState<{ name: string; parsed: ParsedImport } | null>(null);
  const [result, setResult] = useState<MasterImportResult | null>(null);
  const [pending, start] = useTransition();
  const blocking = file ? file.parsed.issues.filter((i) => i.row <= 1 && file.parsed.missingColumns.length) : [];

  return (
    <div className="space-y-3">
      <p className="text-sm text-slate-600">{def.description}</p>
      <div className="flex flex-wrap items-center gap-2">
        <button className="inline-flex items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm hover:bg-slate-50"
          onClick={() => download(`${entity}-template.csv`, templateCsv(def))}><Download size={16} /> Download template</button>
        <FilePicker label="Choose CSV file" onText={(name, text) => { setResult(null); setFile({ name, parsed: parseImportFile(text, def) }); }} />
      </div>
      <p className="text-xs text-slate-500">Required columns: {def.columns.filter((c) => c.required).map((c) => c.name).join(", ")}. Yes/No columns accept yes, no, true, false, 1, 0.</p>

      {file && (
        <div className="rounded-lg border border-slate-200 p-3">
          <div className="flex items-center gap-2 text-sm font-medium"><FileSpreadsheet size={16} /> {file.name} · {file.parsed.rows.length} rows</div>
          {file.parsed.unknownColumns.length > 0 && <p className="mt-1 text-xs text-amber-700">Ignored columns: {file.parsed.unknownColumns.join(", ")}</p>}
          <IssueList issues={file.parsed.issues} />
          <div className="mt-3 flex items-center gap-3">
            <button disabled={pending || blocking.length > 0 || file.parsed.rows.length === 0}
              className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
              onClick={() => start(async () => {
                const r = await importMasterData(entity, file.parsed.rows);
                setResult(r);
                if (r.error) toast.error(r.error);
                else if (r.failed === 0) toast.success(`${r.imported} ${def.label.toLowerCase()} imported`);
                else toast.warning(`${r.imported} imported, ${r.failed} need attention`);
              })}>{pending ? "Importing…" : `Import ${file.parsed.rows.length} rows`}</button>
            <span className="text-xs text-slate-500">Valid rows are saved; rows with problems are listed so you can fix and re-upload just those.</span>
          </div>
        </div>
      )}

      {result && (
        <div className={`rounded-lg border p-3 text-sm ${result.failed || result.error ? "border-amber-200 bg-amber-50" : "border-emerald-200 bg-emerald-50"}`}>
          {result.error ? <span className="text-red-700">{result.error}</span> : (
            <div className="flex items-center gap-2">
              {result.failed ? <AlertTriangle size={16} className="text-amber-600" /> : <CheckCircle2 size={16} className="text-emerald-600" />}
              <span><b>{result.imported}</b> imported{result.failed ? <>, <b>{result.failed}</b> not imported</> : null}</span>
            </div>
          )}
          <IssueList issues={result.results.filter((r) => !r.ok).map((r) => ({ row: r.row, message: r.message ?? "" }))} />
        </div>
      )}
    </div>
  );
}

type Sheet = { name: string; parsed: ParsedImport } | null;

function OpeningPanel() {
  const today = new Date().toISOString().slice(0, 10);
  const [asOf, setAsOf] = useState(today);
  const [sheets, setSheets] = useState<Record<string, Sheet>>({});
  const [result, setResult] = useState<OpeningResult | null>(null);
  const [pending, start] = useTransition();
  const rows = (k: ImportEntity) => sheets[k]?.parsed.rows ?? [];
  const fileIssues = OPENING.flatMap((k) => (sheets[k]?.parsed.issues ?? []).map((i) => ({ ...i, sheet: getEntity(k)!.label })));
  const anyFile = OPENING.some((k) => sheets[k]);

  const run = (dryRun: boolean) => start(async () => {
    const r = await importOpeningBalances({ asOf, stock: rows("opening_stock"), parties: rows("opening_parties"), accounts: rows("opening_accounts"), dryRun });
    setResult(r);
    if (r.error) toast.error(r.error);
    else if (r.issues.length) toast.warning(`${r.issues.length} problem(s) found - nothing was posted`);
    else if (r.posted) toast.success("Opening balances posted");
    else toast.success("All rows check out - ready to post");
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Opening stock and balances are posted together as <b>one balanced journal</b>: stock goes in at cost, customer and supplier balances go on each party&apos;s ledger,
        and whatever is left over is booked to <b>Capital Account</b>. It is all-or-nothing - if any row has a problem nothing is posted. Debtors, Creditors and Stock can only be opened here (never by a manual journal), so the books and sub-ledgers always agree.
        Parties and ledger accounts can be opened <b>once</b>; more stock can be added later.
      </p>
      <label className="block text-sm">Opening date (the day before your first transaction in FertiLedger)
        <input type="date" value={asOf} onChange={(e) => { setAsOf(e.target.value); setResult(null); }} className="mt-1 block rounded-md border border-slate-300 px-3 py-2" />
      </label>

      <div className="grid gap-3 md:grid-cols-3">
        {OPENING.map((k) => {
          const def = getEntity(k)!;
          return (
            <div key={k} className="rounded-lg border border-slate-200 p-3 space-y-2">
              <div className="font-medium text-sm">{def.label}</div>
              <p className="text-xs text-slate-500">{def.columns.filter((c) => c.required).map((c) => c.name).join(", ")}{def.columns.some((c) => !c.required) ? " (+ optional)" : ""}</p>
              <div className="flex flex-wrap gap-2">
                <button className="inline-flex items-center gap-1 rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50" onClick={() => download(`${k}-template.csv`, templateCsv(def))}><Download size={14} /> Template</button>
                <FilePicker label={sheets[k] ? "Replace" : "Choose file"} onText={(name, text) => { setResult(null); setSheets((s) => ({ ...s, [k]: { name, parsed: parseImportFile(text, def) } })); }} />
              </div>
              {sheets[k] && <p className="text-xs text-slate-600">{sheets[k]!.name} · {sheets[k]!.parsed.rows.length} rows
                <button className="ml-2 text-red-600 underline" onClick={() => { setResult(null); setSheets((s) => ({ ...s, [k]: null })); }}>remove</button></p>}
            </div>
          );
        })}
      </div>
      <IssueList issues={fileIssues} />

      <div className="flex flex-wrap items-center gap-3">
        <button disabled={pending || !anyFile || fileIssues.length > 0} onClick={() => run(true)}
          className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium disabled:opacity-50">{pending ? "Checking…" : "1. Check (nothing is posted)"}</button>
        <button disabled={pending || !result || result.issues.length > 0 || !!result.error || result.posted}
          onClick={() => { if (confirm("Post the opening balances? This creates a posted journal and stock batches; it can only be reversed by corrections.")) run(false); }}
          className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">2. Post opening balances</button>
      </div>

      {result && (
        <div className="rounded-lg border border-slate-200 p-3 text-sm space-y-2">
          {result.error && <p className="text-red-700">{result.error}</p>}
          {result.summary && (
            <ul className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
              <li>Stock: <b>{result.summary.stockRows}</b> batches worth <b>{inr(result.summary.stockValue)}</b></li>
              <li>Parties: <b>{result.summary.partyRows}</b> (customers owe <b>{inr(result.summary.debtors)}</b>, you owe suppliers <b>{inr(result.summary.creditors)}</b>)</li>
              <li>Ledger accounts: <b>{result.summary.accountRows}</b></li>
              {result.posted && <li>Booked to Capital Account: <b>{inr(Math.abs(result.summary.capitalBalancing))}</b> {result.summary.capitalBalancing >= 0 ? "credit" : "debit"}</li>}
            </ul>
          )}
          {result.posted && <p className="flex items-center gap-2 text-emerald-700"><CheckCircle2 size={16} /> Posted. Check Accounting → Trial Balance and Inventory → Stock Balance.</p>}
          {!result.posted && !result.error && result.issues.length === 0 && <p className="text-emerald-700">No problems found. Click &ldquo;Post opening balances&rdquo; to book it.</p>}
          <IssueList issues={result.issues} />
        </div>
      )}
    </div>
  );
}

export default function ImportClient() {
  const [tab, setTab] = useState<ImportEntity | "opening">("locations");
  const tabs: { key: ImportEntity | "opening"; label: string; n: number }[] = [
    ...MASTER.map((k, i) => ({ key: k, label: getEntity(k)!.label, n: i + 1 })),
    { key: "opening", label: "Opening stock & balances", n: MASTER.length + 1 },
  ];
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">
        Do these in order: locations → parties → products → farmers → opening stock &amp; balances (later steps refer to earlier ones by code or exact name).
        Save your spreadsheet as <b>CSV</b>; download the template for the exact column names.
      </div>
      <div className="flex flex-wrap gap-2 border-b border-slate-200">
        {tabs.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`-mb-px rounded-t-md border px-3 py-2 text-sm ${tab === t.key ? "border-slate-200 border-b-white bg-white font-semibold text-emerald-700" : "border-transparent text-slate-600 hover:text-slate-900"}`}>
            {t.n}. {t.label}
          </button>
        ))}
      </div>
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        {tab === "opening" ? <OpeningPanel /> : <MasterPanel key={tab} entity={tab} />}
      </div>
    </div>
  );
}
