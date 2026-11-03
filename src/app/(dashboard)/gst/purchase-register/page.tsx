import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getUserContext } from "@/actions/context";
import { getGstPurchaseRegister } from "@/actions/gst";
import PurchaseRegisterClient from "./PurchaseRegisterClient";

export const metadata: Metadata = { title: "GST Purchase Register — FertiLedger ERP" };

export default async function GstPurchaseRegisterPage() {
  try { await getUserContext(); } catch { redirect("/login"); }
  const rows = await getGstPurchaseRegister();
  return <PurchaseRegisterClient initialRows={rows} />;
}
