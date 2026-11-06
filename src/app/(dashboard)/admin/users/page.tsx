import { Suspense } from 'react';
import { getOrgUsers, getInvitations } from '@/actions/admin';
import UsersAdminClient from './UsersAdminClient';

export const metadata = { title: 'Users | FertiLedger ERP' };
export const dynamic = 'force-dynamic';

export default async function UsersAdminPage() {
  const [users, invitations] = await Promise.all([
    getOrgUsers(),
    getInvitations(),
  ]);

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Users & Access</h1>
        <p className="text-sm text-slate-500 mt-1">
          Manage team members, roles and pending invitations
        </p>
      </div>

      <Suspense fallback={<div className="text-slate-400 text-sm">Loading users...</div>}>
        <UsersAdminClient initialUsers={users} initialInvitations={invitations} />
      </Suspense>
    </div>
  );
}
