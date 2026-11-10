import { getPartyOptions } from "@/actions/statements";
import { fyStartOf } from "@/lib/statements";
import LedgerReportClient from "../LedgerReportClient";

export const metadata = { title: "Party Statement | FertiLedger ERP" };
export const dynamic = "force-dynamic";

export default async function PartyStatementPage() {
  const parties = await getPartyOptions();
  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Party Statement</h1>
        <p className="text-sm text-slate-500 mt-1">A customer&apos;s or supplier&apos;s statement of account: invoices, receipts, credit notes and brought-forward balances, with a running balance. Print it or save as CSV to send to the party.</p>
      </div>
      <LedgerReportClient mode="party" options={parties.map((p) => ({ id: p.id, label: p.code ? `${p.name} (${p.code})` : p.name }))}
        defaultFrom={fyStartOf()} today={new Date().toISOString().slice(0, 10)} />
    </div>
  );
}
