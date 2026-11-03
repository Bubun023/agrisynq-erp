"use client";

import { useState, useMemo } from "react";
import { ShoppingCart, Download, Search, TrendingDown, FileCheck } from "lucide-react";
import type { GstPurchaseRow } from "@/actions/gst";

interface Props { initialRows: GstPurchaseRow[]; }

const INR = (n: number) =>
  new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

function getPeriods(rows: GstPurchaseRow[]): string[] {
  const s = new Set(rows.map(r => r.return_period));
  return Array.from(s).sort((a, b) => b.localeCompare(a));
}

function periodLabel(p: string) {
  const mon = ["","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const m = parseInt(p.slice(0, 2), 10);
  return `${mon[m] ?? p.slice(0,2)} ${p.slice(2)}`;
}

export default function PurchaseRegisterClient({ initialRows }: Props) {
  const [search, setSearch] = useState("");
  const [period, setPeriod] = useState("ALL");
  const [rcm, setRcm] = useState("ALL");

  const periods = useMemo(() => getPeriods(initialRows), [initialRows]);

  const filtered = useMemo(() => {
    let rows = initialRows;
    if (period !== "ALL") rows = rows.filter(r => r.return_period === period);
    if (rcm === "RCM") rows = rows.filter(r => r.is_reverse_charge);
    if (rcm === "NORMAL") rows = rows.filter(r => !r.is_reverse_charge);
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter(r =>
        r.invoice_number.toLowerCase().includes(q) ||
        (r.supplier_name ?? "").toLowerCase().includes(q) ||
        (r.supplier_gstin ?? "").toLowerCase().includes(q)
      );
    }
    return rows;
  }, [initialRows, period, rcm, search]);

  const totals = useMemo(() => ({
    taxable:  filtered.reduce((a, r) => a + r.taxable_amount, 0),
    cgst:     filtered.reduce((a, r) => a + r.cgst_amount, 0),
    sgst:     filtered.reduce((a, r) => a + r.sgst_amount, 0),
    igst:     filtered.reduce((a, r) => a + r.igst_amount, 0),
    cess:     filtered.reduce((a, r) => a + r.cess_amount, 0),
    itc:      filtered.reduce((a, r) => a + r.total_itc_claimed, 0),
  }), [filtered]);

  return (
    <div className="max-w-screen-2xl mx-auto space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">GST Purchase Register</h1>
          <p className="page-subtitle">All posted inward supplies & ITC available</p>
        </div>
        <button className="btn-secondary flex items-center gap-2 text-sm">
          <Download className="w-4 h-4" /> Export CSV
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: "Invoices",      value: filtered.length.toString(), icon: ShoppingCart,  color: "text-ink-muted" },
          { label: "Taxable",       value: "₹" + INR(totals.taxable),  icon: TrendingDown,  color: "text-navy-700" },
          { label: "Total GST Paid", value: "₹" + INR(totals.cgst + totals.sgst + totals.igst + totals.cess), icon: FileCheck, color: "text-gold-500" },
          { label: "ITC Available", value: "₹" + INR(totals.itc),      icon: TrendingDown,  color: "text-leaf-600" },
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

      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-3 top-2.5 w-4 h-4 text-ink-muted" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Invoice, supplier, GSTIN…" className="form-input pl-9 text-sm w-full" />
        </div>
        <div className="flex gap-2">
          {["ALL", ...periods].map(p => (
            <button key={p} onClick={() => setPeriod(p)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${period === p ? "bg-navy-800 text-white border-navy-800" : "bg-white text-ink-muted border-surface"}`}>
              {p === "ALL" ? "All Periods" : periodLabel(p)}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          {[["ALL","All"],["NORMAL","Normal ITC"],["RCM","RCM Only"]].map(([val, lbl]) => (
            <button key={val} onClick={() => setRcm(val)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${rcm === val ? "bg-leaf-700 text-white border-leaf-700" : "bg-white text-ink-muted border-surface"}`}>
              {lbl}
            </button>
          ))}
        </div>
      </div>

      <div className="card overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th>Invoice No</th>
              <th>Date</th>
              <th>Supplier</th>
              <th>GSTIN</th>
              <th>RCM</th>
              <th className="text-right">Taxable</th>
              <th className="text-right">CGST</th>
              <th className="text-right">SGST</th>
              <th className="text-right">IGST</th>
              <th className="text-right">Cess</th>
              <th className="text-right">ITC Claimed</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr><td colSpan={11} className="py-12 text-center text-ink-muted">
                <ShoppingCart className="w-10 h-10 mx-auto mb-2 opacity-30" />
                No purchase records for selected filters
              </td></tr>
            ) : filtered.map(r => (
              <tr key={r.id}>
                <td className="font-mono text-leaf-700 text-sm">{r.invoice_number}</td>
                <td className="text-sm">{r.invoice_date}</td>
                <td className="text-sm max-w-[160px] truncate">{r.supplier_name ?? "—"}</td>
                <td className="font-mono text-xs text-ink-muted">{r.supplier_gstin ?? "—"}</td>
                <td>{r.is_reverse_charge ? <span className="badge-danger text-xs">RCM</span> : <span className="text-ink-faint text-xs">—</span>}</td>
                <td className="text-right text-sm">{INR(r.taxable_amount)}</td>
                <td className="text-right text-sm text-ink-muted">{r.is_interstate ? "—" : INR(r.cgst_amount)}</td>
                <td className="text-right text-sm text-ink-muted">{r.is_interstate ? "—" : INR(r.sgst_amount)}</td>
                <td className="text-right text-sm text-ink-muted">{r.is_interstate ? INR(r.igst_amount) : "—"}</td>
                <td className="text-right text-sm text-ink-muted">{r.cess_amount > 0 ? INR(r.cess_amount) : "—"}</td>
                <td className="text-right font-semibold text-sm text-leaf-700">{INR(r.total_itc_claimed)}</td>
              </tr>
            ))}
          </tbody>
          {filtered.length > 0 && (
            <tfoot className="bg-surface-subtle font-semibold text-sm">
              <tr>
                <td colSpan={5} className="text-ink-muted">Totals ({filtered.length})</td>
                <td className="text-right">{INR(totals.taxable)}</td>
                <td className="text-right">{INR(totals.cgst)}</td>
                <td className="text-right">{INR(totals.sgst)}</td>
                <td className="text-right">{INR(totals.igst)}</td>
                <td className="text-right">{INR(totals.cess)}</td>
                <td className="text-right text-leaf-700">{INR(totals.itc)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
