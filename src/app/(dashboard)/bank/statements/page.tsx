import { Suspense } from 'react';
import { getBankStatements, getBankAccounts } from '@/actions/bank';
import BankStatementsClient from './BankStatementsClient';

export const metadata = { title: 'Bank Statements | FertiLedger ERP' };
export const dynamic = 'force-dynamic';

export default async function BankStatementsPage() {
  const [lines, accounts] = await Promise.all([
    getBankStatements({}),
    getBankAccounts(),
  ]);

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Bank Statements</h1>
        <p className="text-sm text-slate-500 mt-1">
          Import bank statement CSV files and view all credit/debit transactions
        </p>
      </div>

      <Suspense fallback={<div className="text-slate-400 text-sm">Loading statements...</div>}>
        <BankStatementsClient
          initialLines={lines}
          bankAccounts={accounts}
        />
      </Suspense>
    </div>
  );
}
