import { Suspense } from 'react';
import { getStockAdjustments, getProductsForLookup, getLocationsForLookup } from '@/actions/inventory';
import StockAdjustmentsClient from './StockAdjustmentsClient';

export const metadata = { title: 'Stock Adjustments | FertiLedger ERP' };
export const dynamic = 'force-dynamic';

export default async function StockAdjustmentsPage() {
  const [adjustments, products, locations] = await Promise.all([
    getStockAdjustments(),
    getProductsForLookup(),
    getLocationsForLookup(),
  ]);

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Stock Adjustments</h1>
        <p className="text-sm text-slate-500 mt-1">
          Record manual stock corrections — damage, expiry write-offs, recounts, samples
        </p>
      </div>

      <Suspense fallback={<div className="text-slate-400 text-sm">Loading adjustments…</div>}>
        <StockAdjustmentsClient
          initialRows={adjustments}
          products={products}
          locations={locations}
        />
      </Suspense>
    </div>
  );
}
