import { Suspense } from 'react';
import { getStockTransfers, getProductsForLookup } from '@/actions/inventory';
import StockTransfersClient from './StockTransfersClient';

export const metadata = { title: 'Stock Transfers | FertiLedger ERP' };
export const dynamic = 'force-dynamic';

export default async function StockTransfersPage() {
  const [transfers, products] = await Promise.all([
    getStockTransfers(),
    getProductsForLookup(),
  ]);

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Stock Transfers</h1>
        <p className="text-sm text-slate-500 mt-1">
          Inter-location transfer log — track movement between warehouses, CF points and branches
        </p>
      </div>

      <Suspense fallback={<div className="text-slate-400 text-sm">Loading transfers…</div>}>
        <StockTransfersClient
          initialRows={transfers as never}
          products={products}
        />
      </Suspense>
    </div>
  );
}
