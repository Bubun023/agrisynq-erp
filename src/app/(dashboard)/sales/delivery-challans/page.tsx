import { redirect } from "next/navigation";

// Delivery challans are managed in the Logistics module.
export default function SalesDeliveryChallansPage() {
  redirect("/logistics/challans");
}
