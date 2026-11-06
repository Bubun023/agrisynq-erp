import { redirect } from 'next/navigation';

// Stock transfers live in the Logistics module (dispatch / receive workflow).
export default function InventoryTransfersPage() {
  redirect('/logistics/transfers');
}
