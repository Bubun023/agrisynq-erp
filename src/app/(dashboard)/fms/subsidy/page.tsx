import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getUserContext } from "@/actions/context";
import { getSubsidyOverview, getSubsidyClaims, getBankAccountOptions } from "@/actions/subsidy";
import SubsidyClaimsClient from "./SubsidyClaimsClient";

export const metadata: Metadata = { title: "Subsidy Claims — FertiLedger ERP" };
export const dynamic = "force-dynamic";

export default async function SubsidyClaimsPage() {
  try { await getUserContext(); } catch { redirect("/login"); }
  const [overview, claims, banks] = await Promise.all([getSubsidyOverview(), getSubsidyClaims(), getBankAccountOptions()]);

  return (
    <div className="max-w-7xl mx-auto">
      <div className="page-header">
        <div>
          <h1 className="page-title">Subsidy Claims</h1>
          <p className="page-subtitle">Claim the subsidy on posted farmer sales from the government and record each payment received</p>
        </div>
      </div>
      <SubsidyClaimsClient overview={overview} claims={claims} banks={banks} />
    </div>
  );
}
