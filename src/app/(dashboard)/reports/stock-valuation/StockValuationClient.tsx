"use client";

import { useEffect, useState, useTransition } from "react";
import { getStockAgeing, getStockValuation, type StockAgeingRow, type StockValuationRow } from "@/actions/statements";
import { ErrorBox, Field, ReportBar, RunButton, inputCls, inr, dmy } from "@/components/reports/ReportBits";

type Val = { rows: StockValuationRow[]; booksValue: number; inTransit: number };
const BUCKETS = ["0-30", "31-60", "61-90", "91-180", "180+"];
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export default function StockValuationClient({ today }: { today: string }) {
  const [asOf, setAsOf] = useState(today);
  const [tab, setTab] = useState<"valuation" | "ageing">("valuation");
  const [val, setVal] = useState<Val | null>(null);
  const [age, setAge] = useState<StockAgeingRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const run = () => start(async () => {
    const [v, a] = await Promise.all([getStockValuation(asOf), getStockAgeing(asOf)]);
    if ("error" in v) { setError(v.error); return; }
    if ("error" in a) { setError(a.error); return; }
    setError(null); setVal(v); setAge(a.rows);
  });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { run(); }, []);

  const total = val ? r2(val.rows.reduce((s, r) => s + r.value, 0)) : 0;
  const diff = val ? r2(val.booksValue - total - val.inTransit) : 0;
  const byProduct = new Map<string, { name: string; qty: number; value: number }>();
  val?.rows.forEach((r) => { const p = byProduct.get(r.product_id) ?? { name: r.product_name, qty: 0, value: 0 }; p.qty += r.qty; p.value = r2(p.value + r.value); byProduct.set(r.product_id, p); });
  const bucketTotals = BUCKETS.map((b) => ({ b, value: r2((age ?? []).filter((r) => r.age_bucket === b).reduce((s, r) => s + r.value, 0)) }));
  const expiring = (age ?? []).filter((r) => r.expiry_status === "EXPIRED" || r.expiry_status === "EXPIRING_90");

  return (
    <div className="space-y-4">
      <ReportBar filename={`stock-${tab}-${asOf}.csv`}
        csv={tab === "valuation" && val ? { columns: [{ key: "product_name", label: "Product" }, { key: "location_name", label: "Location" }, { key: "batch_number", label: "Batch" }, { key: "expiry_date", label: "Expiry" }, { key: "qty", label: "Qty" }, { key: "unit_cost", label: "Cost/unit" }, { key: "value", label: "Value" }], rows: val.rows as unknown as Record<string, unknown>[] }
          : age ? { columns: [{ key: "product_name", label: "Product" }, { key: "location_name", label: "Location" }, { key: "batch_number", label: "Batch" }, { key: "received_on", label: "Received" }, { key: "age_days", label: "Age (days)" }, { key: "age_bucket", label: "Bucket" }, { key: "expiry_date", label: "Expiry" }, { key: "expiry_status", label: "Expiry status" }, { key: "qty", label: "Qty" }, { key: "value", label: "Value" }], rows: age as unknown as Record<string, unknown>[] } : undefined}>
        <Field label="As on"><input type="date" className={inputCls} value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
        <RunButton pending={pending} onClick={run} />
        <div className="flex gap-1 rounded-md border border-slate-200 bg-white p-1">
          {(["valuation", "ageing"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`rounded px-3 py-1.5 text-sm ${tab === t ? "bg-emerald-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}>{t === "valuation" ? "Valuation" : "Ageing & expiry"}</button>
          ))}
        </div>
      </ReportBar>
      <ErrorBox message={error} />

      {val && tab === "valuation" && (
        <>
          <div className="grid gap-3 sm:grid-cols-4">
            <Stat label="Stock on hand (at cost)" value={inr(total)} />
            <Stat label="Goods in transit" value={inr(val.inTransit)} />
            <Stat label="Stock in Hand in the books" value={inr(val.booksValue)} />
            <Stat label="Difference" value={inr(diff)} tone={diff === 0 ? "good" : "bad"} />
          </div>
          {diff !== 0 && <ErrorBox message={`Stock does not tie to the books by ${inr(diff)}. Look for entries posted straight to Stock in Hand (manual journals) or stock movements that were not accounted for.`} />}
          <Table head={["Product", "Qty", "Value"]} right={[1, 2]}
            rows={Array.from(byProduct.values()).map((p) => [p.name, String(p.qty), inr(p.value)])} foot={["Total", "", inr(total)]} title="By product" />
          <Table head={["Product", "Location", "Batch", "Expiry", "Qty", "Cost/unit", "Value"]} right={[4, 5, 6]}
            rows={val.rows.map((r) => [r.product_name, r.location_name ?? "", r.batch_number ?? "", dmy(r.expiry_date), String(r.qty), inr(r.unit_cost), inr(r.value)])} title="By batch and location" />
        </>
      )}

      {age && tab === "ageing" && (
        <>
          <div className="grid gap-3 sm:grid-cols-5">{bucketTotals.map((b) => <Stat key={b.b} label={`${b.b} days`} value={inr(b.value)} />)}</div>
          {expiring.length > 0 && (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              {expiring.filter((r) => r.expiry_status === "EXPIRED").length} batch(es) already expired and {expiring.filter((r) => r.expiry_status === "EXPIRING_90").length} expiring within 90 days -
              worth {inr(r2(expiring.reduce((s, r) => s + r.value, 0)))} at cost.
            </div>
          )}
          <Table head={["Product", "Location", "Batch", "Received", "Age (days)", "Bucket", "Expiry", "Status", "Qty", "Value"]} right={[4, 8, 9]}
            rows={age.map((r) => [r.product_name, r.location_name ?? "", r.batch_number ?? "", dmy(r.received_on), String(r.age_days), r.age_bucket, dmy(r.expiry_date),
              r.expiry_status === "EXPIRED" ? "EXPIRED" : r.expiry_status === "EXPIRING_90" ? `Expires in ${r.days_to_expiry}d` : r.expiry_status === "OK" ? "OK" : "-", String(r.qty), inr(r.value)])}
            foot={["Total", "", "", "", "", "", "", "", "", inr(r2(age.reduce((s, r) => s + r.value, 0)))]} title="Oldest first" />
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "good" | "bad" }) {
  return (
    <div className={`rounded-lg border p-3 ${tone === "bad" ? "border-red-200 bg-red-50" : tone === "good" ? "border-emerald-200 bg-emerald-50" : "border-slate-200 bg-white"}`}>
      <div className="text-xs text-slate-500">{label}</div><div className="mt-1 text-lg font-semibold text-slate-900">{value}</div>
    </div>
  );
}

function Table({ title, head, rows, right, foot }: { title: string; head: string[]; rows: string[][]; right: number[]; foot?: string[] }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-4 py-2 font-semibold text-slate-800">{title}</div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-600"><tr>{head.map((h, i) => <th key={h} className={`px-3 py-2 ${right.includes(i) ? "text-right" : ""}`}>{h}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i} className="border-t border-slate-100">{r.map((c, j) => <td key={j} className={`px-3 py-1.5 ${right.includes(j) ? "text-right" : ""}`}>{c}</td>)}</tr>)}</tbody>
          {foot && <tfoot className="border-t-2 border-slate-300 bg-slate-50 font-semibold"><tr>{foot.map((c, j) => <td key={j} className={`px-3 py-2 ${right.includes(j) ? "text-right" : ""}`}>{c}</td>)}</tr></tfoot>}
        </table>
      </div>
      {rows.length === 0 && <div className="px-4 py-3 text-sm text-slate-500">No stock on this date.</div>}
    </div>
  );
}
