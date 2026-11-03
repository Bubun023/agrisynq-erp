"use client";

import { useState } from "react";
import { Calculator, ChevronDown } from "lucide-react";
import type { Gstr3bRow } from "@/actions/gst";

interface Props { initialRows: Gstr3bRow[]; }

const INR = (n: number) =>
  new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);

function periodLabel(p: string) {
  const mon = ["","Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return `${mon[parseInt(p.slice(0,2),10)] ?? p.slice(0,2)} ${p.slice(2)}`;
}

function SummaryRow({ label, value, sub, indent }: { label: string; value: number; sub?: boolean; indent?: boolean }) {
  return (
    <tr className={sub ? "bg-surface-subtle/40" : ""}>
      <td className={`text-sm ${indent ? "pl-8" : "pl-4"} py-2 ${sub ? "text-ink-muted" : "font-medium"}`}>{label}</td>
      <td className="text-right text-sm pr-4 py-2 font-mono">{INR(value)}</td>
    </tr>
  );
}

export default function Gstr3bClient({ initialRows }: Props) {
  const [selected, setSelected] = useState(initialRows[0]?.return_period ?? "");

  const row = initialRows.find(r => r.return_period === selected) ?? initialRows[0];

  if (!row) {
    return (
      <div className="max-w-screen-xl mx-auto">
        <div className="page-header">
          <h1 className="page-title">GSTR-3B Summary</h1>
          <p className="page-subtitle">Monthly net tax liability summary</p>
        </div>
        <div className="card py-16 text-center text-ink-muted">
          <Calculator className="w-12 h-12 mx-auto mb-3 opacity-30" />
          <p>No posted invoices yet. Post sales and purchase invoices to see GSTR-3B summary.</p>
        </div>
      </div>
    );
  }

  const totalGstPayable = row.net_cgst_payable + row.net_sgst_payable + row.net_igst_payable;

  return (
    <div className="max-w-screen-xl mx-auto space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">GSTR-3B Summary</h1>
          <p className="page-subtitle">Monthly summary return for net tax liability</p>
        </div>
        <div className="relative">
          <select
            value={selected}
            onChange={e => setSelected(e.target.value)}
            className="form-input text-sm pr-8 appearance-none"
          >
            {initialRows.map(r => (
              <option key={r.return_period} value={r.return_period}>{periodLabel(r.return_period)}</option>
            ))}
          </select>
          <ChevronDown className="absolute right-2 top-2.5 w-4 h-4 text-ink-muted pointer-events-none" />
        </div>
      </div>

      {/* Net payable banner */}
      <div className={`rounded-xl p-5 flex items-center justify-between ${totalGstPayable > 0 ? "bg-red-50 border border-red-200" : "bg-green-50 border border-green-200"}`}>
        <div>
          <p className="text-sm font-medium text-ink-muted">Net GST Payable — {periodLabel(row.return_period)}</p>
          <p className={`text-3xl font-bold mt-1 ${totalGstPayable > 0 ? "text-red-700" : "text-green-700"}`}>
            ₹{INR(totalGstPayable)}
          </p>
        </div>
        <div className="text-right text-sm space-y-1">
          {row.net_cgst_payable > 0 && <p className="text-ink-muted">CGST: <span className="font-semibold text-ink">₹{INR(row.net_cgst_payable)}</span></p>}
          {row.net_sgst_payable > 0 && <p className="text-ink-muted">SGST: <span className="font-semibold text-ink">₹{INR(row.net_sgst_payable)}</span></p>}
          {row.net_igst_payable > 0 && <p className="text-ink-muted">IGST: <span className="font-semibold text-ink">₹{INR(row.net_igst_payable)}</span></p>}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Table 3.1 */}
        <div className="card">
          <div className="px-4 py-3 border-b border-surface font-semibold text-sm bg-surface-subtle">
            Table 3.1 — Outward Supplies
          </div>
          <table className="w-full">
            <tbody>
              <SummaryRow label="Total Taxable Sales"     value={row.taxable_sales} />
              <SummaryRow label="CGST on Sales"          value={row.cgst_on_sales}  sub indent />
              <SummaryRow label="SGST on Sales"          value={row.sgst_on_sales}  sub indent />
              <SummaryRow label="IGST on Sales"          value={row.igst_on_sales}  sub indent />
              <SummaryRow label="Cess on Sales"          value={row.cess_on_sales}  sub indent />
              <SummaryRow label="Export Turnover"        value={row.export_value} />
            </tbody>
          </table>
        </div>

        {/* Table 3.2 RCM */}
        <div className="card">
          <div className="px-4 py-3 border-b border-surface font-semibold text-sm bg-surface-subtle">
            Table 3.2 — Reverse Charge (RCM)
          </div>
          <table className="w-full">
            <tbody>
              <SummaryRow label="RCM Inward Taxable"  value={row.rcm_inward_taxable} />
              <SummaryRow label="RCM Tax Payable"     value={row.rcm_tax_payable} />
            </tbody>
          </table>
        </div>

        {/* Table 4 ITC */}
        <div className="card">
          <div className="px-4 py-3 border-b border-surface font-semibold text-sm bg-surface-subtle">
            Table 4 — ITC Available
          </div>
          <table className="w-full">
            <tbody>
              <SummaryRow label="Total ITC Available"  value={row.total_itc} />
              <SummaryRow label="CGST ITC"             value={row.itc_cgst}  sub indent />
              <SummaryRow label="SGST ITC"             value={row.itc_sgst}  sub indent />
              <SummaryRow label="IGST ITC"             value={row.itc_igst}  sub indent />
              <SummaryRow label="Cess ITC"             value={row.itc_cess}  sub indent />
            </tbody>
          </table>
        </div>

        {/* Table 6 — Net Payable */}
        <div className="card">
          <div className="px-4 py-3 border-b border-surface font-semibold text-sm bg-surface-subtle">
            Table 6 — Net Tax Payable (after ITC)
          </div>
          <table className="w-full">
            <tbody>
              <SummaryRow label="CGST Net Payable" value={row.net_cgst_payable} />
              <SummaryRow label="SGST Net Payable" value={row.net_sgst_payable} />
              <SummaryRow label="IGST Net Payable" value={row.net_igst_payable} />
            </tbody>
          </table>
          <div className="px-4 py-3 border-t border-surface flex justify-between items-center">
            <span className="font-bold text-sm">Total Net Payable</span>
            <span className={`font-bold text-lg ${totalGstPayable > 0 ? "text-red-700" : "text-green-700"}`}>
              ₹{INR(totalGstPayable)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
