"use client";

import { useState, useMemo } from "react";
import { FileText, Download, Search, TrendingUp, FileCheck } from "lucide-react";
import type { GstSalesRow } from "@/actions/gst";

interface Props { initialRows: GstSalesRow[]; }

const INR = (n: number) =>
  new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

const SECTION_LABELS: Record<string, { label: string; color: string }> = {
  B2B:     { label: "B2B",     color: "badge-info" },
  B2CL:    { label: "B2CL",   color: "badge" },
  B2CS:    { label: "B2CS",   color: "badge" },
  EXP:     { label: "Export", color: "badge-warning" },
  SEZ:     { label: "SEZ",    color: "badge-warning" },
  B2B_RCM: { label: "B2B-RCM", color: "badge-danger" },
};

// Build period list (MMYYYY) from data
function getPeriods(rows: GstSalesRow[]): string[] {
  const s = new Set(rows.map(r => r.return_period));
  return Array.from(s).sort((a, b) => b.localeCompare(a));
}

function periodLabel(p: string) {
  const mon = ["", "Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const m = parseInt(p.slice(0, 2), 10);
  const y = p.slice(2);
  return `${mon[m] ?? p.slice(0,2)} ${y}`;
}

export default function SalesRegisterClient({ initialRows }: Props) {
  const [search, setSearch] = useState("");
  const [period, setPeriod] = useState("ALL");
  const [section, setSection] = useState("ALL");

  const periods = useMemo(() => getPeriods(initialRows), [initialRows]);

  const filtered = useMemo(() => {
    let rows = initialRows;
    if (period !== "ALL") rows = rows.filter(r => r.return_period === period);
    if (section !== "ALL") rows = rows.filter(r => r.gstr1_section === section);
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(r =>
        r.invoice_number.toLowerCase().includes(q) ||
        (r.customer_name ?? "").toLowerCase().includes(q) ||
        (r.customer_gstin ?? "").toLowerCase().includes(q)
      );
    }
    return rows;
  }, [initialRows, period, section, search]);

  const totals = useMemo(() => ({
    taxable: filtered.reduce((a, r) => a + r.taxable_amount, 0),
    cgst:    filtered.reduce((a, r) => a + r.cgst_amount, 0),
    sgst:    filtered.reduce((a, r) => a + r.sgst_amount, 0),
    igst:    filtered.reduce((a, r) => a + r.igst_amount, 0),
    cess:    filtered.reduce((a, r) => a + r.cess_amount, 0),
    total:   filtered.reduce((a, r) => a + r.net_receivable, 0),
  }), [filtered]);

  return (
    <div className="max-w-screen-2xl mx-auto space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">GST Sales Register</h1>
          <p className="page-subtitle">All posted outward supplies — source for GSTR-1</p>
        </div>
        <button className="btn-secondary flex items-center gap-2 text-sm">
          <Download className="w-4 h-4" />
          Export CSV
        </button>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Invoices",     value: filtered.length.toString(), icon: FileText,  color: "text-ink-muted" },
          { label: "Taxable",      value: "₹" + INR(totals.taxable), icon: TrendingUp, color: "text-leaf-600" },
          { label: "Total GST",    value: "₹" + INR(totals.cgst + totals.sgst + totals.igst + totals.cess), icon: FileCheck, color: "text-gold-500" },
          { label: "Net Receivable", value: "₹" + INR(totals.total), icon: TrendingUp, color: "text-leaf-700" },
        ].map(c => (
          <div key={c.label} className="card p-4 flex items-center gap-3">
            <c.icon className={`w-8 h-8 ${c.color}`} />
            <div>
              <p className="text-xs text-ink-muted">{c.label}</p>
              <p className="font-semibold text-ink text-sm">{c.value}</p>
            </div>
          </div>
        ))}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-2.5 w-4 h-4 text-ink-muted" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Invoice, customer, GSTIN…"
            className="form-input pl-9 text-sm w-full"
          />
        </div>
        <div className="flex gap-2 flex-wrap">
          {["ALL", ...periods].map(p => (
            <button
              key={p}
              onClick={() => setPeriod(p)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${period === p ? "bg-navy-800 text-white border-navy-800" : "bg-white text-ink-muted border-surface hover:border-navy-300"}`}
            >
              {p === "ALL" ? "All Periods" : periodLabel(p)}
            </button>
          ))}
        </div>
        <div className="flex gap-2 flex-wrap">
          {["ALL", "B2B", "B2CS", "B2CL", "EXP", "B2B_RCM"].map(s => (
            <button
              key={s}
              onClick={() => setSection(s)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${section === s ? "bg-leaf-700 text-white border-leaf-700" : "bg-white text-ink-muted border-surface hover:border-leaf-300"}`}
            >
              {s === "ALL" ? "All Sections" : s}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="card overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Invoice No</th>
              <th>Date</th>
              <th>Section</th>
              <th>Customer</th>
              <th>GSTIN</th>
              <th>POS</th>
              <th className="text-right">Taxable</th>
              <th className="text-right">CGST</th>
              <th className="text-right">SGST</th>
              <th className="text-right">IGST</th>
              <th className="text-right">Cess</th>
              <th className="text-right">Net Recv.</th>
              <th>IRN</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={13} className="py-12 text-center text-ink-muted">
                  <FileText className="w-10 h-10 mx-auto mb-2 opacity-30" />
                  No records for selected filters
                </td>
              </tr>
            ) : (
              filtered.map(r => {
                const sec = SECTION_LABELS[r.gstr1_section] ?? { label: r.gstr1_section, color: "badge" };
                return (
                  <tr key={r.id}>
                    <td className="font-mono text-leaf-700 text-sm">{r.invoice_number}</td>
                    <td className="text-sm">{r.invoice_date}</td>
                    <td><span className={sec.color}>{sec.label}</span></td>
                    <td className="text-sm max-w-[160px] truncate">{r.customer_name ?? "—"}</td>
                    <td className="font-mono text-xs text-ink-muted">{r.customer_gstin ?? "—"}</td>
                    <td className="text-xs">{r.place_of_supply ?? "—"}</td>
                    <td className="text-right text-sm">{INR(r.taxable_amount)}</td>
                    <td className="text-right text-sm text-ink-muted">{r.is_interstate ? "—" : INR(r.cgst_amount)}</td>
                    <td className="text-right text-sm text-ink-muted">{r.is_interstate ? "—" : INR(r.sgst_amount)}</td>
                    <td className="text-right text-sm text-ink-muted">{r.is_interstate ? INR(r.igst_amount) : "—"}</td>
                    <td className="text-right text-sm text-ink-muted">{r.cess_amount > 0 ? INR(r.cess_amount) : "—"}</td>
                    <td className="text-right font-semibold text-sm">{INR(r.net_receivable)}</td>
                    <td>
                      {r.irn ? (
                        <span className="badge-success text-xs">e-Invoice</span>
                      ) : (
                        <span className="text-xs text-ink-faint">—</span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
          {filtered.length > 0 && (
            <tfoot className="bg-surface-subtle font-semibold text-sm">
              <tr>
                <td colSpan={6} className="text-ink-muted">Totals ({filtered.length} invoices)</td>
                <td className="text-right">{INR(totals.taxable)}</td>
                <td className="text-right">{INR(totals.cgst)}</td>
                <td className="text-right">{INR(totals.sgst)}</td>
                <td className="text-right">{INR(totals.igst)}</td>
                <td className="text-right">{INR(totals.cess)}</td>
                <td className="text-right text-leaf-700">{INR(totals.total)}</td>
                <td></td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
