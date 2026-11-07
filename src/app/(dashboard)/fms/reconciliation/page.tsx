import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getUserContext } from "@/actions/context";
import { getFmsReconciliations } from "@/actions/fms";
import FmsReconciliationClient from "./FmsReconciliationClient";

export const metadata: Metadata = { title: "FMS Reconciliation — FertiLedger ERP" };
export const dynamic = "force-dynamic";

export default async function FmsReconciliationPage() {
  try { await getUserContext(); } catch { redirect("/login"); }
  const rows = await getFmsReconciliations();

  return (
    <div className="max-w-7xl mx-auto">
      <div className="page-header">
        <div>
          <h1 className="page-title">FMS Reconciliation</h1>
          <p className="page-subtitle">
            Compare FMS/iFMS portal totals with your posted farmer sales, and document how each variance was resolved
          </p>
        </div>
      </div>
      <FmsReconciliationClient initialRows={rows} />
    </div>
  );
}
