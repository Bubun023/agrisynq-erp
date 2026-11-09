"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, ArrowRightLeft } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/utils";
import StockJournalDialog, { type JournalLookups } from "@/components/inventory/StockJournalDialog";
import type { StockJournalRow } from "@/actions/stock-journals";

export default function StockJournalsClient({ journals, lookups }: { journals: StockJournalRow[]; lookups: JournalLookups }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-ink-muted">Each journal takes stock out of some batches and brings other products in, carrying the value across.</p>
        <button onClick={() => setOpen(true)} className="btn-primary flex items-center gap-2"><Plus className="w-4 h-4" />New stock journal</button>
      </div>

      <div className="card overflow-x-auto">
        {journals.length === 0 ? (
          <div className="p-12 text-center"><ArrowRightLeft className="w-8 h-8 text-ink-faint mx-auto mb-3" strokeWidth={1.5} />
            <p className="text-ink-muted font-medium">No stock journals yet</p></div>
        ) : (
          <table className="data-table">
            <thead><tr><th>Journal</th><th>Date</th><th>Location</th><th>Out</th><th>In</th><th className="text-right">Value</th><th>Reason</th></tr></thead>
            <tbody>
              {journals.map((j) => (
                <tr key={j.id}>
                  <td className="font-mono text-sm text-leaf-700">{j.journal_no}</td>
                  <td className="text-sm">{formatDate(j.journal_date)}</td>
                  <td className="text-sm">{j.location?.name}</td>
                  <td className="text-sm">{j.lines.filter((l) => l.direction === "OUT").map((l) => `${l.product?.name} ×${Number(l.qty)}`).join(", ")}</td>
                  <td className="text-sm">{j.lines.filter((l) => l.direction === "IN").map((l) => `${l.product?.name} ×${Number(l.qty)}`).join(", ")}</td>
                  <td className="text-right font-mono text-sm">{formatCurrency(Number(j.total_value))}</td>
                  <td className="text-sm max-w-[260px] truncate" title={j.reason}>{j.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {open && <StockJournalDialog lookups={lookups} onClose={() => setOpen(false)} onDone={() => { setOpen(false); router.refresh(); }} />}
    </div>
  );
}
