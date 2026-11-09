import { getUserContext } from "@/actions/context";
import ImportClient from "./ImportClient";

export const metadata = { title: "Data Import | FertiLedger ERP" };
export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const ctx = await getUserContext();
  const allowed = ["SUPER_ADMIN", "BRANCH_ADMIN", "ACCOUNTANT"].includes(ctx.roleName ?? "");
  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Data Import</h1>
        <p className="text-sm text-slate-500 mt-1">Bring your existing parties, products, farmers, stock and balances into FertiLedger from CSV files.</p>
      </div>
      {allowed ? <ImportClient /> : (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
          Only an admin or accountant can import data. Ask one of them to do it, or have your role changed.
        </div>
      )}
    </div>
  );
}
