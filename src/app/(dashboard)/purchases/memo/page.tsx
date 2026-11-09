import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getUserContext } from "@/actions/context";
import { getMemoPurchases, getPendingMemoLines, getPendingBySupplier } from "@/actions/memo";
import { getLogisticsFormLookups } from "@/actions/logistics";
import { getJournalLookups } from "@/actions/stock-journals";
import MemoPurchasesClient from "./MemoPurchasesClient";

export const metadata: Metadata = { title: "Memo Purchases — FertiLedger ERP" };
export const dynamic = "force-dynamic";

export default async function PurchaseMemoPage() {
  try { await getUserContext(); } catch { redirect("/login"); }
  const [memos, pendingLines, pendingSuppliers, lookups, journalLookups] = await Promise.all([
    getMemoPurchases(), getPendingMemoLines(), getPendingBySupplier(), getLogisticsFormLookups(), getJournalLookups(),
  ]);

  return (
    <div className="max-w-7xl mx-auto">
      <div className="page-header">
        <div>
          <h1 className="page-title">Memo Purchases</h1>
          <p className="page-subtitle">Goods received before the supplier&apos;s invoice — tracked at cost until the invoice arrives, then matched to it</p>
        </div>
      </div>
      <MemoPurchasesClient
        memos={memos}
        pendingLines={pendingLines}
        pendingSuppliers={pendingSuppliers}
        parties={lookups.parties as { id: string; name: string; party_type: string }[]}
        products={lookups.products as { id: string; name: string; product_code: string | null; unit_of_measure: string }[]}
        locations={lookups.locations.map((l) => ({ id: l.id, name: l.name }))}
        journalLookups={journalLookups}
      />
    </div>
  );
}
