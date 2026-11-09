import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getUserContext } from "@/actions/context";
import { getGatePasses, getPendingGatePasses } from "@/actions/gate-passes";
import GatePassesClient from "./GatePassesClient";

export const metadata: Metadata = { title: "Gate Passes — FertiLedger ERP" };
export const dynamic = "force-dynamic";

export default async function GatePassesPage() {
  try { await getUserContext(); } catch { redirect("/login"); }
  const [passes, pending] = await Promise.all([getGatePasses(), getPendingGatePasses()]);

  return (
    <div className="max-w-7xl mx-auto">
      <div className="page-header">
        <div>
          <h1 className="page-title">Gate Passes</h1>
          <p className="page-subtitle">Record every vehicle that passes the gate with goods, tied to the transfer, invoice or challan it carries</p>
        </div>
      </div>
      <GatePassesClient passes={passes} pending={pending} />
    </div>
  );
}
