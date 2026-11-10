"use client";

import { Download, Printer } from "lucide-react";
import { toCsv } from "@/lib/statements";

export const inr = (n: number) => (n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const dmy = (d: string | null | undefined) => (d ? d.split("-").reverse().join("-") : "");

export function ReportBar({ csv, filename, children }: { csv?: { columns: { key: string; label: string }[]; rows: Record<string, unknown>[] }; filename: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end gap-3 print:hidden">
      {children}
      <div className="ml-auto flex gap-2">
        {csv && (
          <button className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm hover:bg-slate-50"
            onClick={() => {
              const url = URL.createObjectURL(new Blob([toCsv(csv.columns, csv.rows)], { type: "text/csv;charset=utf-8" }));
              const a = document.createElement("a"); a.href = url; a.download = filename; a.click(); URL.revokeObjectURL(url);
            }}><Download size={15} /> CSV</button>
        )}
        <button className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm hover:bg-slate-50" onClick={() => window.print()}><Printer size={15} /> Print</button>
      </div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-sm text-slate-700">{label}<div className="mt-1">{children}</div></label>;
}
export const inputCls = "rounded-md border border-slate-300 bg-white px-3 py-2 text-sm";
export function RunButton({ pending, onClick, label = "Show" }: { pending: boolean; onClick: () => void; label?: string }) {
  return <button disabled={pending} onClick={onClick} className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{pending ? "Loading…" : label}</button>;
}
export function ErrorBox({ message }: { message: string | null }) {
  return message ? <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">{message}</div> : null;
}
