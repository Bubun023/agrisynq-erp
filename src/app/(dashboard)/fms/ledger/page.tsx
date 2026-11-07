import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getUserContext } from "@/actions/context";
import { getFmsLedger } from "@/actions/fms";
import FmsLedgerClient from "./FmsLedgerClient";

export const metadata: Metadata = { title: "FMS Ledger — FertiLedger ERP" };
export const dynamic = "force-dynamic";

export default async function FmsLedgerPage() {
  try { await getUserContext(); } catch { redirect("/login"); }
  const rows = await getFmsLedger();

  return (
    <div className="max-w-7xl mx-auto">
      <div className="page-header">
        <div>
          <h1 className="page-title">FMS Ledger</h1>
          <p className="page-subtitle">
            Farmer sales ready for FMS/iFMS portal reconciliation, with compliance checks and CSV export
          </p>
        </div>
      </div>
      <FmsLedgerClient initialRows={rows} />
    </div>
  );
}
