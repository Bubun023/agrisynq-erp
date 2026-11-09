import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getUserContext } from "@/actions/context";
import { getCfWithdrawals, getCfStock, getOwnLocationOptions } from "@/actions/cf";
import CfWithdrawalsClient from "./CfWithdrawalsClient";

export const metadata: Metadata = { title: "C&F Withdrawals — FertiLedger ERP" };
export const dynamic = "force-dynamic";

export default async function CfWithdrawalsPage() {
  try { await getUserContext(); } catch { redirect("/login"); }
  const [withdrawals, stock, ownLocations] = await Promise.all([getCfWithdrawals(), getCfStock(), getOwnLocationOptions()]);

  return (
    <div className="max-w-7xl mx-auto">
      <div className="page-header">
        <div>
          <h1 className="page-title">C&amp;F Withdrawals</h1>
          <p className="page-subtitle">Bring stock back from a C&amp;F agent — needs the company&apos;s approval reference before it can be dispatched</p>
        </div>
      </div>
      <CfWithdrawalsClient
        withdrawals={withdrawals as unknown as Parameters<typeof CfWithdrawalsClient>[0]["withdrawals"]}
        stock={stock}
        ownLocations={ownLocations}
      />
    </div>
  );
}
