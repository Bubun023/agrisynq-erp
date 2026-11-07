"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ChevronRight, Download } from "lucide-react";
import type { GstSalesRow } from "@/actions/gst";

interface Gstr1Data {
  period: string;
  b2b: GstSalesRow[];
  b2cl: GstSalesRow[];
  b2cs: GstSalesRow[];
  exp: GstSalesRow[];
  rcm: GstSalesRow[];
  cdnr: GstSalesRow[];
  totals: { taxable: number; cgst: number; sgst: number; igst: number; cess: number; invoices: number };
}

interface Props { data: Gstr1Data; currentPeriod: string; }

const INR = (n: number) =>
  new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

function periodLabel(p: string) {
  const mon = ["","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${mon[parseInt(p.slice(0,2),10)] ?? p.slice(0,2)} ${p.slice(2)}`;
}

type TabKey = "summary" | "b2b" | "b2cs" | "b2cl" | "exp" | "rcm";

function InvoiceTable({ rows, section }: { rows: GstSalesRow[]; section: string }) {
  if (rows.length === 0)
    return <p className="py-8 text-center text-ink-muted text-sm">No {section} invoices in this period.</p>;
  const tot = (k: keyof GstSalesRow) => rows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  return (
    <div className="overflow-x-auto">
      <table className="data-table text-sm">
        <thead>
          <tr>
            <th>Invoice No</th><th>Date</th><th>Customer</th>
            <th>GSTIN</th><th>POS</th>
            <th className="text-right">Taxable</th>
            <th className="text-right">CGST</th><th className="text-right">SGST</th>
            <th className="text-right">IGST</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id}>
              <td className="font-mono text-leaf-700">{r.invoice_number}</td>
              <td>{r.invoice_date}</td>
              <td className="max-w-[140px] truncate">{r.customer_name ?? "—"}</td>
              <td className="font-mono text-xs text-ink-muted">{r.customer_gstin ?? "—"}</td>
              <td className="text-xs">{r.place_of_supply ?? "—"}</td>
              <td className="text-right">{INR(r.taxable_amount)}</td>
              <td className="text-right text-ink-muted">{r.is_interstate ? "—" : INR(r.cgst_amount)}</td>
              <td className="text-right text-ink-muted">{r.is_interstate ? "—" : INR(r.sgst_amount)}</td>
              <td className="text-right text-ink-muted">{r.is_interstate ? INR(r.igst_amount) : "—"}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="bg-surface-subtle font-semibold">
          <tr>
            <td colSpan={5} className="text-ink-muted">{rows.length} invoices</td>
            <td className="text-right">{INR(tot("taxable_amount"))}</td>
            <td className="text-right">{INR(tot("cgst_amount"))}</td>
            <td className="text-right">{INR(tot("sgst_amount"))}</td>
            <td className="text-right">{INR(tot("igst_amount"))}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export default function Gstr1Client({ data, currentPeriod }: Props) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<TabKey>("summary");
  const [period, setPeriod] = useState(currentPeriod);

  function applyPeriod() {
    router.push(`?period=${period}`);
  }

  const sections: { key: TabKey; label: string; section: string; count: number; rows: GstSalesRow[] }[] = [
    { key: "b2b",  label: "B2B",          section: "B2B",     count: data.b2b.length,  rows: data.b2b  },
    { key: "b2cs", label: "B2CS",         section: "B2CS",    count: data.b2cs.length, rows: data.b2cs },
    { key: "b2cl", label: "B2CL",         section: "B2CL",    count: data.b2cl.length, rows: data.b2cl },
    { key: "exp",  label: "Exports/SEZ",  section: "EXP/SEZ", count: data.exp.length,  rows: data.exp  },
    { key: "rcm",  label: "RCM Outward",  section: "RCM",     count: data.rcm.length,  rows: data.rcm  },
  ];

  return (
    <div className="max-w-screen-xl mx-auto space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">GSTR-1</h1>
          <p className="page-subtitle">Monthly outward supply return — {periodLabel(currentPeriod)}</p>
        </div>
        <div className="flex gap-2 items-center">
          <input type="month" className="form-input text-sm"
            value={`${period.slice(2)}-${period.slice(0,2)}`}
            onChange={e => { const [y,m] = e.target.value.split("-"); setPeriod(`${m}${y}`); }}
          />
          <button onClick={applyPeriod} className="btn-primary text-sm">Load</button>
          <button className="btn-secondary flex items-center gap-1 text-sm"><Download className="w-4 h-4"/>Export JSON</button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-3 md:grid-cols-6 gap-3">
        {[
          { label: "Invoices",  value: data.totals.invoices.toString() },
          { label: "Taxable",   value: "₹" + INR(data.totals.taxable) },
          { label: "CGST",      value: "₹" + INR(data.totals.cgst) },
          { label: "SGST",      value: "₹" + INR(data.totals.sgst) },
          { label: "IGST",      value: "₹" + INR(data.totals.igst) },
          { label: "Cess",      value: "₹" + INR(data.totals.cess) },
        ].map(c => (
          <div key={c.label} className="card p-3 text-center">
            <p className="text-xs text-ink-muted">{c.label}</p>
            <p className="font-bold text-ink text-sm mt-0.5">{c.value}</p>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="border-b border-surface flex gap-0">
        {(["summary", ...sections.map(s => s.key)] as TabKey[]).map(t => (
          <button key={t} onClick={() => setActiveTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors capitalize ${activeTab === t ? "border-leaf-600 text-leaf-700" : "border-transparent text-ink-muted hover:text-ink"}`}>
            {t === "summary" ? "Summary" : sections.find(s => s.key === t)?.label ?? t}
          </button>
        ))}
      </div>

      {activeTab === "summary" && (
        <div className="card divide-y divide-surface">
          <div className="px-4 py-3 font-semibold text-sm text-ink bg-surface-subtle">GSTR-1 Sections</div>
          {sections.map(s => (
            <div key={s.key} className="px-4 py-3 flex items-center justify-between hover:bg-surface-subtle/40 cursor-pointer"
              onClick={() => setActiveTab(s.key)}>
              <span className="font-medium text-sm">{s.label}</span>
              <div className="flex items-center gap-4">
                <span className="text-ink-muted text-sm">{s.count} invoice{s.count !== 1 ? "s" : ""}</span>
                <span className="font-semibold text-sm">₹{INR(s.rows.reduce((a, r) => a + r.taxable_amount, 0))}</span>
                <ChevronRight className="w-4 h-4 text-ink-muted" />
              </div>
            </div>
          ))}
        </div>
      )}

      {sections.map(s => activeTab === s.key && (
        <div key={s.key} className="card">
          <div className="px-4 py-3 border-b border-surface font-semibold text-sm">{s.label} — {s.count} invoice{s.count !== 1 ? "s" : ""}</div>
          <InvoiceTable rows={s.rows} section={s.section} />
        </div>
      ))}
    </div>
  );
}
