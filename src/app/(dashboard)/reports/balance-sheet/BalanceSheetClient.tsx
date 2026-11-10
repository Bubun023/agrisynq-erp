"use client";

import { useState, useTransition } from "react";
import { getBalanceSheet } from "@/actions/statements";
import type { BalanceSheet, BsGroup } from "@/lib/statements";
import { ErrorBox, Field, ReportBar, RunButton, inputCls, inr, dmy } from "@/components/reports/ReportBits";

type Data = { sheet: BalanceSheet; asOf: string };

function Side({ title, groups, total, extra }: { title: string; groups: BsGroup[]; total: number; extra?: { label: string; amount: number }[] }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <div className="border-b border-slate-200 px-4 py-2 font-semibold text-slate-800">{title}</div>
      <div className="divide-y divide-slate-100">
        {groups.map((g) => (
          <div key={g.group} className="px-4 py-2">
            <div className="flex justify-between text-sm font-medium text-slate-700"><span>{g.group}</span><span>{inr(g.total)}</span></div>
            {g.accounts.map((a) => (
              <div key={a.code} className="flex justify-between pl-4 text-sm text-slate-600"><span>{a.code} · {a.name}</span><span>{inr(a.amount)}</span></div>
            ))}
          </div>
        ))}
        {extra?.map((e) => (
          <div key={e.label} className="flex justify-between px-4 py-2 text-sm font-medium text-slate-700"><span>{e.label}</span><span>{inr(e.amount)}</span></div>
        ))}
        {groups.length === 0 && !extra?.length && <div className="px-4 py-3 text-sm text-slate-400">Nothing to show</div>}
      </div>
      <div className="flex justify-between border-t border-slate-300 px-4 py-2 font-semibold text-slate-900"><span>Total {title.toLowerCase()}</span><span>{inr(total)}</span></div>
    </div>
  );
}

export default function BalanceSheetClient({ initial, initialError, today }: { initial: Data | null; initialError: string | null; today: string }) {
  const [asOf, setAsOf] = useState(today);
  const [data, setData] = useState<Data | null>(initial);
  const [error, setError] = useState<string | null>(initialError);
  const [pending, start] = useTransition();
  const run = () => start(async () => {
    const r = await getBalanceSheet(asOf);
    if ("error" in r) { setError(r.error); } else { setError(null); setData(r); }
  });
  const s = data?.sheet;
  const csvRows = s ? [
    ...s.assets.flatMap((g) => g.accounts.map((a) => ({ section: "Assets", group: g.group, code: a.code, account: a.name, amount: a.amount }))),
    ...s.liabilities.flatMap((g) => g.accounts.map((a) => ({ section: "Liabilities", group: g.group, code: a.code, account: a.name, amount: a.amount }))),
    ...s.equity.flatMap((g) => g.accounts.map((a) => ({ section: "Equity", group: g.group, code: a.code, account: a.name, amount: a.amount }))),
    { section: "Equity", group: "Profit", code: "", account: "Profit / (loss) to date", amount: s.profit },
  ] : [];

  return (
    <div className="space-y-4">
      <ReportBar filename={`balance-sheet-${data?.asOf ?? asOf}.csv`} csv={s ? { columns: [{ key: "section", label: "Section" }, { key: "group", label: "Group" }, { key: "code", label: "Code" }, { key: "account", label: "Account" }, { key: "amount", label: "Amount" }], rows: csvRows } : undefined}>
        <Field label="As on"><input type="date" className={inputCls} value={asOf} onChange={(e) => setAsOf(e.target.value)} /></Field>
        <RunButton pending={pending} onClick={run} />
      </ReportBar>
      <ErrorBox message={error} />
      {s && data && (
        <>
          <p className="text-sm text-slate-600">Balance sheet as on <b>{dmy(data.asOf)}</b>.</p>
          <div className="grid gap-4 lg:grid-cols-2">
            <Side title="Assets" groups={s.assets} total={s.totalAssets} />
            <div className="space-y-4">
              <Side title="Liabilities" groups={s.liabilities} total={s.totalLiabilities} />
              <Side title="Equity" groups={s.equity} total={r2(s.totalEquity + s.profit)}
                extra={[{ label: s.profit >= 0 ? "Profit to date (income less expenses)" : "Loss to date (income less expenses)", amount: s.profit }]} />
            </div>
          </div>
          <div className={`rounded-md border p-3 text-sm ${s.difference === 0 ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-200 bg-red-50 text-red-800"}`}>
            {s.difference === 0
              ? <>Balanced: assets {inr(s.totalAssets)} = liabilities {inr(s.totalLiabilities)} + equity {inr(r2(s.totalEquity + s.profit))}.</>
              : <>Out of balance by {inr(s.difference)} - this should never happen; please report it.</>}
            <span className="ml-2 text-slate-500">Income {inr(s.totalIncome)} · Expenses {inr(s.totalExpense)}. Profit is cumulative to the date (the books are not closed year by year).</span>
          </div>
        </>
      )}
    </div>
  );
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
