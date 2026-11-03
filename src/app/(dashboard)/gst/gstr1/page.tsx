import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getUserContext } from "@/actions/context";
import { getGstr1Data } from "@/actions/gst";
import Gstr1Client from "./Gstr1Client";

export const metadata: Metadata = { title: "GSTR-1 — FertiLedger ERP" };

// Default to current period
function currentPeriod() {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${m}${d.getFullYear()}`;
}

export default async function Gstr1Page({ searchParams }: { searchParams: { period?: string } }) {
  try { await getUserContext(); } catch { redirect("/login"); }
  const period = searchParams.period ?? currentPeriod();
  const data = await getGstr1Data(period);
  return <Gstr1Client data={data} currentPeriod={period} />;
}
