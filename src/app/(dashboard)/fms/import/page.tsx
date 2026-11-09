import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getUserContext } from "@/actions/context";
import { getFmsImportBatches } from "@/actions/fms";
import FmsImportClient from "./FmsImportClient";

export const metadata: Metadata = { title: "Import FMS Data — FertiLedger ERP" };
export const dynamic = "force-dynamic";

export default async function FmsImportPage() {
  try { await getUserContext(); } catch { redirect("/login"); }
  const batches = await getFmsImportBatches();

  return (
    <div className="max-w-7xl mx-auto">
      <div className="page-header">
        <div>
          <h1 className="page-title">Import FMS Data</h1>
          <p className="page-subtitle">
            Upload the transaction report from the FMS/iFMS portal and match every line to your sales by PoS transaction ID
          </p>
        </div>
      </div>
      <FmsImportClient initialBatches={batches} />
    </div>
  );
}
