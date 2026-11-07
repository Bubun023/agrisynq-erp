"use client";

import { useMemo, useState } from "react";
import { Download, AlertCircle, ScrollText } from "lucide-react";
import { cn, formatCurrency, formatDate } from "@/lib/utils";
import type { FmsLedgerRow, ComplianceFlag } from "@/actions/fms";

const FLAG_LABEL: Record<ComplianceFlag, string> = {
  OK: "OK",
  MISSING_POS: "Missing PoS ID",
  POS_PENDING: "PoS pending",
  NO_DEALER_ID: "No dealer ID",
  CANCELLED: "Cancelled",
};
const FLAG_BADGE: Record<ComplianceFlag, string> = {
  OK: "badge-success",
  MISSING_POS: "badge-danger",
  POS_PENDING: "badge-warning",
  NO_DEALER_ID: "badge-warning",
  CANCELLED: "badge-gray",
};
const SUBSIDY_LABEL: Record<string, string> = {
  NEEM_COATED_UREA: "Neem-coated urea",
  NBS_FERTILIZER: "NBS",
  STATE_SUBSIDY: "State",
  NONE: "None",
};

/** CSV cell: quote everything, and neutralise spreadsheet formulas (farmer names are free text). */
function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

function downloadCsv(rows: FmsLedgerRow[]) {
  const header = [
    "Sale No", "Date", "FMS Dealer ID", "FMS Product Code", "Product", "HSN", "Batch",
    "Farmer", "Aadhaar (last 4)", "Village", "District", "Qty", "UoM",
    "Selling Price/Unit", "Subsidy/Unit", "Total Subsidy", "Farmer Paid (excl. GST)", "Subsidy Type",
    "PoS Transaction ID", "PoS Device ID", "FMS Ack No", "Status", "Compliance",
  ];
  const lines = rows.map((r) => [
    r.sale_number, r.sale_date, r.fms_dealer_id, r.fms_product_code, r.product_name, r.hsn_code, r.batch_number,
    r.farmer_name, r.farmer_aadhaar_last4, r.farmer_village, r.farmer_district, r.qty_sold, r.unit_of_measure,
    r.selling_price_per_unit, r.subsidy_per_unit, r.total_subsidy_amount, r.farmer_payable_amount, r.subsidy_type,
    r.pos_transaction_id, r.pos_device_id, r.fms_acknowledgement_no, r.status, r.compliance_flag,
  ].map(csvCell).join(","));
  const blob = new Blob(["﻿" + [header.map(csvCell).join(","), ...lines].join("\r\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `fms-ledger-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export default function FmsLedgerClient({ initialRows }: { initialRows: FmsLedgerRow[] }) {
  const [search, setSearch] = useState("");
  const [flag, setFlag] = useState("");
  const [subsidy, setSubsidy] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return initialRows.filter((r) =>
      (!flag || r.compliance_flag === flag) &&
      (!subsidy || r.subsidy_type === subsidy) &&
      (!from || r.sale_date >= from) &&
      (!to || r.sale_date <= to) &&
      (!q ||
        r.farmer_name.toLowerCase().includes(q) ||
        r.sale_number.toLowerCase().includes(q) ||
        (r.pos_transaction_id ?? "").toLowerCase().includes(q)),
    );
  }, [initialRows, search, flag, subsidy, from, to]);

  const live = rows.filter((r) => r.compliance_flag !== "CANCELLED");   // cancelled sales are shown but not counted
  const totalQty = live.reduce((s, r) => s + Number(r.qty_sold), 0);
  const totalSubsidy = live.reduce((s, r) => s + Number(r.total_subsidy_amount), 0);
  const issues = live.filter((r) => r.compliance_flag !== "OK").length;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="stat-card"><p className="stat-label">Transactions</p><p className="stat-value">{live.length}</p></div>
        <div className="stat-card"><p className="stat-label">Quantity sold</p><p className="stat-value">{totalQty.toLocaleString("en-IN", { maximumFractionDigits: 3 })}</p></div>
        <div className="stat-card"><p className="stat-label">Subsidy</p><p className="stat-value">{formatCurrency(totalSubsidy)}</p></div>
        <div className="stat-card">
          <p className="stat-label">Compliance issues</p>
          <p className={cn("stat-value", issues > 0 && "text-danger-600")}>{issues}</p>
        </div>
      </div>

      <div className="card p-4 flex flex-wrap items-end gap-3">
        <input className="form-input text-sm w-full sm:w-64" type="search" placeholder="Search farmer, sale no, PoS ID…"
          value={search} onChange={(e) => setSearch(e.target.value)} />
        <label className="text-xs text-ink-muted">From
          <input className="form-input text-sm block" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="text-xs text-ink-muted">To
          <input className="form-input text-sm block" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <select className="form-input text-sm" value={flag} onChange={(e) => setFlag(e.target.value)} aria-label="Compliance filter">
          <option value="">All compliance</option>
          {Object.entries(FLAG_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className="form-input text-sm" value={subsidy} onChange={(e) => setSubsidy(e.target.value)} aria-label="Subsidy filter">
          <option value="">All subsidy types</option>
          {Object.entries(SUBSIDY_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <button onClick={() => downloadCsv(rows)} disabled={rows.length === 0}
          className="btn-primary ml-auto flex items-center gap-2 disabled:opacity-50">
          <Download className="w-4 h-4" />Export CSV
        </button>
      </div>

      <div className="card overflow-x-auto">
        {rows.length === 0 ? (
          <div className="p-12 text-center">
            <ScrollText className="w-8 h-8 text-ink-faint mx-auto mb-3" strokeWidth={1.5} />
            <p className="text-ink-muted font-medium">No FMS transactions match</p>
            <p className="text-sm text-ink-faint mt-1">Farmer sales appear here once recorded under Sales → Memo Sales.</p>
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Sale No</th><th>Date</th><th>Farmer</th><th>Product</th>
                <th className="text-right">Qty</th><th className="text-right">Subsidy</th>
                <th>PoS Txn ID</th><th>Status</th><th>Compliance</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className={cn(r.compliance_flag === "MISSING_POS" && "bg-red-50/50", r.compliance_flag === "CANCELLED" && "opacity-60")}>
                  <td><span className="font-mono text-sm text-leaf-700">{r.sale_number}</span></td>
                  <td className="text-sm">{formatDate(r.sale_date)}</td>
                  <td>
                    <div className="text-sm font-medium">{r.farmer_name}</div>
                    <div className="text-xs text-ink-faint">
                      {[r.farmer_village, r.farmer_district].filter(Boolean).join(", ")}
                      {r.farmer_aadhaar_last4 ? ` · XXXX-${r.farmer_aadhaar_last4}` : ""}
                    </div>
                  </td>
                  <td>
                    <div className="text-sm">{r.product_name}</div>
                    <div className="text-xs text-ink-faint">{SUBSIDY_LABEL[r.subsidy_type] ?? r.subsidy_type}{r.batch_number ? ` · ${r.batch_number}` : ""}</div>
                  </td>
                  <td className="text-right font-mono text-sm">{Number(r.qty_sold)} {r.unit_of_measure}</td>
                  <td className="text-right font-mono text-sm">{formatCurrency(Number(r.total_subsidy_amount))}</td>
                  <td className="font-mono text-xs">{r.pos_transaction_id ?? <span className="text-danger-600 inline-flex items-center gap-1"><AlertCircle className="w-3 h-3" />none</span>}</td>
                  <td><span className="badge badge-info text-2xs">{r.status.replace(/_/g, " ")}</span></td>
                  <td><span className={cn("badge text-2xs", FLAG_BADGE[r.compliance_flag])}>{FLAG_LABEL[r.compliance_flag]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
