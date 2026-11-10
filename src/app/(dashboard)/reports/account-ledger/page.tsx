import { getAccountOptions } from "@/actions/statements";
import { fyStartOf } from "@/lib/statements";
import LedgerReportClient from "../LedgerReportClient";

export const metadata = { title: "Account Ledger | FertiLedger ERP" };
export const dynamic = "force-dynamic";

export default async function AccountLedgerPage() {
  const accounts = await getAccountOptions();
  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Account Ledger</h1>
        <p className="text-sm text-slate-500 mt-1">Every posted entry on one account for a period, with the brought-forward balance and a running total.</p>
      </div>
      <LedgerReportClient mode="account" options={accounts.map((a) => ({ id: a.id, label: `${a.code} · ${a.name}` }))}
        defaultFrom={fyStartOf()} today={new Date().toISOString().slice(0, 10)} />
    </div>
  );
}
