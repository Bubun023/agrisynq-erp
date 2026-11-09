import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getUserContext } from "@/actions/context";
import { getStockJournals, getJournalLookups } from "@/actions/stock-journals";
import StockJournalsClient from "./StockJournalsClient";

export const metadata: Metadata = { title: "Stock Journal — FertiLedger ERP" };
export const dynamic = "force-dynamic";

export default async function StockJournalsPage() {
  try { await getUserContext(); } catch { redirect("/login"); }
  const [journals, lookups] = await Promise.all([getStockJournals(), getJournalLookups()]);

  return (
    <div className="max-w-7xl mx-auto">
      <div className="page-header">
        <div>
          <h1 className="page-title">Stock Journal</h1>
          <p className="page-subtitle">Move stock from one product to another at the same value — for example when a supplier bills product B but delivers product A</p>
        </div>
      </div>
      <StockJournalsClient journals={journals} lookups={lookups} />
    </div>
  );
}
