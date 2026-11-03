import { Suspense } from 'react';
import { getBankStatements, getBankAccounts } from '@/actions/bank';
import BankReconciliationClient from './BankReconciliationClient';

export const metadata = { title: 'Bank Reconciliation | FertiLedger ERP' };
export const dynamic = 'force-dynamic';

export default async function BankReconciliationPage() {
  const [lines, accounts] = await Promise.all([
    getBankStatements({ reconStatus: undefined }),
    getBankAccounts(),
  ]);

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Bank Reconciliation</h1>
        <p className="text-sm text-slate-500 mt-1">
          Match statement lines to journal vouchers and receipts. Manually match or exclude lines.
        </p>
      </div>

      <Suspense fallback={<div className="text-slate-400 text-sm">Loading reconciliation...</div>}>
        <BankReconciliationClient
          initialLines={lines}
          bankAccounts={accounts}
        />
      </Suspense>
    </div>
  );
}
