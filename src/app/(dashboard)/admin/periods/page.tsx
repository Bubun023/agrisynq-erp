import { Suspense } from 'react';
import { getPeriodLocks } from '@/actions/admin';
import PeriodLocksClient from './PeriodLocksClient';

export const metadata = { title: 'Period Locking | FertiLedger ERP' };
export const dynamic = 'force-dynamic';

export default async function PeriodLocksPage() {
  const locks = await getPeriodLocks();

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Period Locking</h1>
        <p className="text-sm text-slate-500 mt-1">
          Lock closed accounting periods to prevent backdated entries
        </p>
      </div>

      <Suspense fallback={<div className="text-slate-400 text-sm">Loading periods...</div>}>
        <PeriodLocksClient initialLocks={locks} />
      </Suspense>
    </div>
  );
}
