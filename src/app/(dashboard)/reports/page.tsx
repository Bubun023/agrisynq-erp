import { Suspense } from 'react';
import ReportsTabShell from './ReportsTabShell';
import {
  getPLReport,
  getAgeingReceivables,
  getAgeingPayables,
  getStockSummaryReport,
  getDayBook,
} from '@/actions/reports';

export const metadata = { title: 'Reports | FertiLedger ERP' };
export const dynamic = 'force-dynamic';

const today      = new Date().toISOString().split('T')[0];
const fyStart    = (() => {
  const d = new Date();
  const yr = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1;
  return `${yr}-04`;
})();
const thisMonth  = today.slice(0, 7);

export default async function ReportsPage() {
  const [plRows, arRows, apRows, stockRows, dayBookRows] = await Promise.all([
    getPLReport({ fromMonth: fyStart, toMonth: thisMonth }),
    getAgeingReceivables(),
    getAgeingPayables(),
    getStockSummaryReport(),
    getDayBook({ fromDate: today, toDate: today }),
  ]);

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Reports</h1>
        <p className="text-sm text-slate-500 mt-1">
          P&amp;L Statement, Outstanding Ageing, Stock Summary, Day Book
        </p>
      </div>

      <Suspense fallback={<div className="text-slate-400 text-sm">Loading reports...</div>}>
        <ReportsTabShell
          plRows={plRows}
          arRows={arRows}
          apRows={apRows}
          stockRows={stockRows}
          dayBookRows={dayBookRows}
        />
      </Suspense>
    </div>
  );
}
