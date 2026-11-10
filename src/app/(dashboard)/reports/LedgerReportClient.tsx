"use client";

import { useMemo, useState, useTransition } from "react";
import { getAccountLedger, getPartyStatement, type LedgerRow } from "@/actions/statements";
import { ErrorBox, Field, ReportBar, RunButton, inputCls, inr, dmy } from "@/components/reports/ReportBits";

type Option = { id: string; label: string };

/** Shared by the Account Ledger and the Party Statement: pick one, pick a period, see every entry with a running balance. */
export default function LedgerReportClient({ mode, options, defaultFrom, today }: { mode: "account" | "party"; options: Option[]; defaultFrom: string; today: string }) {
  const [id, setId] = useState("");
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(today);
  const [filter, setFilter] = useState("");
  const [rows, setRows] = useState<LedgerRow[] | null>(null);
  const [shown, setShown] = useState<{ label: string; from: string; to: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const noun = mode === "account" ? "account" : "party";
  const visible = useMemo(() => options.filter((o) => o.label.toLowerCase().includes(filter.toLowerCase())).slice(0, 200), [options, filter]);

  const run = () => start(async () => {
    const r = mode === "account" ? await getAccountLedger(id, from, to) : await getPartyStatement(id, from, to);
    if ("error" in r) { setError(r.error); setRows(null); return; }
    setError(null); setRows(r.rows); setShown({ label: options.find((o) => o.id === id)?.label ?? "", from, to });
  });

  const totals = rows ? rows.filter((r) => r.particulars !== "Brought forward").reduce((t, r) => ({ dr: t.dr + r.debit, cr: t.cr + r.credit }), { dr: 0, cr: 0 }) : null;
  const closing = rows && rows.length ? rows[rows.length - 1].running_balance : 0;
  const bal = (n: number) => `${inr(Math.abs(n))} ${n >= 0 ? "Dr" : "Cr"}`;
  const colLabel = mode === "account" ? "Party" : "Account";

  return (
    <div className="space-y-4">
      <ReportBar filename={`${noun}-${shown?.label.replace(/[^\w]+/g, "-") ?? "ledger"}-${to}.csv`}
        csv={rows ? { columns: [{ key: "txn_date", label: "Date" }, { key: "voucher_no", label: "Voucher" }, { key: "voucher_type", label: "Type" }, { key: "particulars", label: "Particulars" },
                                 { key: mode === "account" ? "party_name" : "account_code", label: colLabel }, { key: "debit", label: "Debit" }, { key: "credit", label: "Credit" }, { key: "running_balance", label: "Balance (Dr+/Cr-)" }],
                     rows: rows as unknown as Record<string, unknown>[] } : undefined}>
        <Field label={`Find ${noun}`}><input className={inputCls} placeholder="type to narrow the list" value={filter} onChange={(e) => setFilter(e.target.value)} /></Field>
        <Field label={noun === "account" ? "Account" : "Party"}>
          <select className={`${inputCls} min-w-64`} value={id} onChange={(e) => setId(e.target.value)}>
            <option value="">Select…</option>
            {visible.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </Field>
        <Field label="From"><input type="date" className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><input type="date" className={inputCls} value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <RunButton pending={pending} onClick={run} label={mode === "account" ? "Show ledger" : "Show statement"} />
      </ReportBar>
      <ErrorBox message={error} />

      {rows && shown && totals && (
        <div className="rounded-lg border border-slate-200 bg-white">
          <div className="border-b border-slate-200 px-4 py-3">
            <div className="font-semibold text-slate-900">{shown.label}</div>
            <div className="text-sm text-slate-500">{dmy(shown.from)} to {dmy(shown.to)}{mode === "party" ? " · positive (Dr) = the party owes you, Cr = you owe the party" : ""}</div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-slate-600">
                <tr><th className="px-3 py-2">Date</th><th className="px-3 py-2">Voucher</th><th className="px-3 py-2">Particulars</th><th className="px-3 py-2">{colLabel}</th>
                  <th className="px-3 py-2 text-right">Debit</th><th className="px-3 py-2 text-right">Credit</th><th className="px-3 py-2 text-right">Balance</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.seq} className={`border-t border-slate-100 ${r.particulars === "Brought forward" ? "bg-slate-50 font-medium" : ""}`}>
                    <td className="px-3 py-1.5 whitespace-nowrap">{dmy(r.txn_date)}</td>
                    <td className="px-3 py-1.5 whitespace-nowrap">{r.voucher_no ?? ""}<span className="ml-1 text-xs text-slate-400">{r.voucher_type ?? ""}</span></td>
                    <td className="px-3 py-1.5">{r.particulars}</td>
                    <td className="px-3 py-1.5 text-slate-500">{(mode === "account" ? r.party_name : r.account_code) ?? ""}</td>
                    <td className="px-3 py-1.5 text-right">{r.debit ? inr(r.debit) : ""}</td>
                    <td className="px-3 py-1.5 text-right">{r.credit ? inr(r.credit) : ""}</td>
                    <td className="px-3 py-1.5 text-right whitespace-nowrap">{bal(r.running_balance)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t-2 border-slate-300 bg-slate-50 font-semibold">
                <tr><td className="px-3 py-2" colSpan={4}>Period total</td><td className="px-3 py-2 text-right">{inr(totals.dr)}</td><td className="px-3 py-2 text-right">{inr(totals.cr)}</td><td className="px-3 py-2 text-right">{bal(closing)}</td></tr>
              </tfoot>
            </table>
          </div>
          {rows.length <= 1 && <div className="px-4 py-3 text-sm text-slate-500">No entries in this period.</div>}
        </div>
      )}
    </div>
  );
}
