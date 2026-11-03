import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getUserContext } from "@/actions/context";
import { getGstSalesRegister } from "@/actions/gst";
import SalesRegisterClient from "./SalesRegisterClient";

export const metadata: Metadata = { title: "GST Sales Register — FertiLedger ERP" };

export default async function GstSalesRegisterPage() {
  try { await getUserContext(); } catch { redirect("/login"); }
  const rows = await getGstSalesRegister();
  return <SalesRegisterClient initialRows={rows} />;
}
