import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getUserContext } from "@/actions/context";
import { getGstr3bSummary } from "@/actions/gst";
import Gstr3bClient from "./Gstr3bClient";

export const metadata: Metadata = { title: "GSTR-3B — FertiLedger ERP" };

export default async function Gstr3bPage() {
  try { await getUserContext(); } catch { redirect("/login"); }
  const rows = await getGstr3bSummary();
  return <Gstr3bClient initialRows={rows} />;
}
