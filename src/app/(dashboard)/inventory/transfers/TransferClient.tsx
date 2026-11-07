"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeftRight, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { createStockTransfer, type StockFormState } from "@/actions/stock-ledger";

const INITIAL: StockFormState = {};

export default function TransferClient() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const today = new Date().toISOString().split("T")[0];

  const handleAction = (formData: FormData) => {
    startTransition(async () => {
      const result = await createStockTransfer(INITIAL, formData);
      if (result.success) {
        toast.success("Stock transfer posted to ledger.");
        router.refresh();
      } else if (result.fieldErrors) {
        const errs = Object.values(result.fieldErrors).flat();
        toast.error(errs[0] ?? "Validation error.");
      } else {
        toast.error(result.error ?? "Transfer failed.");
      }
    });
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Stock Transfers</h1>
          <p className="page-subtitle">Move stock between locations — creates paired TRANSFER_OUT and TRANSFER_IN ledger entries</p>
        </div>
      </div>

      <div className="flex items-start gap-3 px-4 py-3 rounded-lg bg-blue-50 border border-blue-200">
        <ArrowLeftRight className="w-4 h-4 text-blue-700 mt-0.5 shrink-0" />
        <p className="text-sm text-blue-700">
          Transfers are <strong>irreversible</strong> but can be corrected via Stock Adjustments.
          Both locations must exist and the source batch must have sufficient stock.
        </p>
      </div>

      <div className="card p-6">
        <form action={handleAction} className="space-y-4">
          <div>
            <label className="form-label">Product ID (UUID) *</label>
            <input name="product_id" required placeholder="Product UUID"
              className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-navy-500/20" />
          </div>
          <div>
            <label className="form-label">Batch ID (UUID) *</label>
            <input name="batch_id" required placeholder="Batch UUID from batch register"
              className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-navy-500/20" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="form-label">From Location (UUID) *</label>
              <input name="from_location_id" required placeholder="Source location UUID"
                className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-navy-500/20" />
            </div>
            <div>
              <label className="form-label">To Location (UUID) *</label>
              <input name="to_location_id" required placeholder="Destination location UUID"
                className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-navy-500/20" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="form-label">Transfer Qty *</label>
              <input type="number" name="transfer_qty" required min="0.001" step="0.001" placeholder="0.000"
                className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-500/20" />
            </div>
            <div>
              <label className="form-label">Unit of Measure *</label>
              <input name="unit_of_measure" required placeholder="e.g. MT, KG, BAG"
                className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-500/20" />
            </div>
          </div>
          <div>
            <label className="form-label">Movement Date *</label>
            <input type="date" name="movement_date" defaultValue={today} required
              className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-500/20" />
          </div>
          <div>
            <label className="form-label">Narration</label>
            <textarea name="narration" rows={2} placeholder="Reason for transfer (e.g. C&F depot consolidation)"
              className="w-full border border-surface-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-navy-500/20 resize-none" />
          </div>
          <button type="submit" disabled={isPending}
            className="w-full bg-navy-950 text-white py-2.5 rounded-lg text-sm font-medium hover:bg-navy-800 disabled:opacity-60 transition-colors inline-flex items-center justify-center gap-2">
            {isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            Post Stock Transfer
          </button>
        </form>
      </div>

      <p className="text-xs text-ink-faint text-center">
        UUID selectors will be replaced with searchable dropdowns in Phase 4 (Purchase &amp; Sales Invoices).
      </p>
    </div>
  );
}
