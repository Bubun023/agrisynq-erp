import { Suspense } from 'react';
import { getStockLedger, getProductsForLookup, getLocationsForLookup } from '@/actions/inventory';
import StockLedgerClient from './StockLedgerClient';

export const metadata = { title: 'Stock Ledger | FertiLedger ERP' };
export const dynamic = 'force-dynamic';

export default async function StockLedgerPage() {
  const [rows, products, locations] = await Promise.all([
    getStockLedger({ limit: 200 }),
    getProductsForLookup(),
    getLocationsForLookup(),
  ]);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Stock Ledger</h1>
          <p className="text-sm text-slate-500 mt-1">
            Complete movement history — GRN receipts, sales issues, credit note returns, adjustments
          </p>
        </div>
      </div>

      <Suspense fallback={<div className="text-slate-400 text-sm">Loading ledger…</div>}>
        <StockLedgerClient
          initialRows={rows}
          products={products}
          locations={locations}
        />
      </Suspense>
    </div>
  );
}
