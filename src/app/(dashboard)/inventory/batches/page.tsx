import { Suspense } from 'react';
import { getBatchRegister, getProductsForLookup } from '@/actions/inventory';
import BatchRegisterClient from './BatchRegisterClient';

export const metadata = { title: 'Batch Register | FertiLedger ERP' };
export const dynamic = 'force-dynamic';

export default async function BatchRegisterPage() {
  const [batches, products] = await Promise.all([
    getBatchRegister(),
    getProductsForLookup(),
  ]);

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Batch Register</h1>
        <p className="text-sm text-slate-500 mt-1">
          All product batches with expiry status, purchase rate, MRP and current stock
        </p>
      </div>

      <Suspense fallback={<div className="text-slate-400 text-sm">Loading batches…</div>}>
        <BatchRegisterClient
          initialRows={batches}
          products={products}
        />
      </Suspense>
    </div>
  );
}
