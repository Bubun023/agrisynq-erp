import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getUserContext } from "@/actions/context";
import { getGstr2bImports } from "@/actions/gst";
import Gstr2bClient from "./Gstr2bClient";

export const metadata: Metadata = { title: "GSTR-2B Reconciliation — FertiLedger ERP" };

export default async function Gstr2bPage() {
  try { await getUserContext(); } catch { redirect("/login"); }
  const imports = await getGstr2bImports();
  return <Gstr2bClient initialImports={imports} />;
}
