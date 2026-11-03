import { Suspense } from 'react';
import { getBankAccounts } from '@/actions/bank';
import BankAccountsClient from './BankAccountsClient';

export const metadata = { title: 'Bank Accounts | FertiLedger ERP' };
export const dynamic = 'force-dynamic';

export default async function BankAccountsPage() {
  const accounts = await getBankAccounts();

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Bank Accounts</h1>
        <p className="text-sm text-slate-500 mt-1">
          Manage bank accounts and view live balances computed from statement imports
        </p>
      </div>

      <Suspense fallback={<div className="text-slate-400 text-sm">Loading accounts...</div>}>
        <BankAccountsClient initialAccounts={accounts} />
      </Suspense>
    </div>
  );
}
