import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getUserContext } from "@/actions/context";
import { getCfStock } from "@/actions/cf";
import CfStockClient from "./CfStockClient";

export const metadata: Metadata = { title: "C&F Stock Register — FertiLedger ERP" };
export const dynamic = "force-dynamic";

export default async function CfStockPage() {
  try { await getUserContext(); } catch { redirect("/login"); }
  const rows = await getCfStock();

  return (
    <div className="max-w-7xl mx-auto">
      <div className="page-header">
        <div>
          <h1 className="page-title">C&amp;F Stock Register</h1>
          <p className="page-subtitle">
            Stock legally yours but physically held by C&amp;F agents — taken from the stock ledger, with the agent&apos;s confirmed counts alongside
          </p>
        </div>
      </div>
      <CfStockClient rows={rows} />
    </div>
  );
}
