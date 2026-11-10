import { getBalanceSheet } from "@/actions/statements";
import BalanceSheetClient from "./BalanceSheetClient";

export const metadata = { title: "Balance Sheet | FertiLedger ERP" };
export const dynamic = "force-dynamic";

export default async function BalanceSheetPage() {
  const today = new Date().toISOString().slice(0, 10);
  const first = await getBalanceSheet(today);
  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Balance Sheet</h1>
        <p className="text-sm text-slate-500 mt-1">Assets, liabilities and equity as on any date, straight from the posted books.</p>
      </div>
      <BalanceSheetClient initial={"error" in first ? null : first} initialError={"error" in first ? first.error : null} today={today} />
    </div>
  );
}
