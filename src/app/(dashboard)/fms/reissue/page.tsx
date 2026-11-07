import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getUserContext } from "@/actions/context";
import { getCancellableFarmerSales, getCancelledFarmerSales } from "@/actions/fms";
import FmsReissueClient from "./FmsReissueClient";

export const metadata: Metadata = { title: "Cancel & Reissue — FertiLedger ERP" };
export const dynamic = "force-dynamic";

export default async function FmsReissuePage() {
  try { await getUserContext(); } catch { redirect("/login"); }
  const [sales, cancelled] = await Promise.all([getCancellableFarmerSales(), getCancelledFarmerSales()]);

  return (
    <div className="max-w-7xl mx-auto">
      <div className="page-header">
        <div>
          <h1 className="page-title">Cancel &amp; Reissue</h1>
          <p className="page-subtitle">Correct a wrong farmer sale: reverse it properly and reissue it under a new PoS transaction ID</p>
        </div>
      </div>
      <FmsReissueClient sales={sales} cancelled={cancelled} />
    </div>
  );
}
