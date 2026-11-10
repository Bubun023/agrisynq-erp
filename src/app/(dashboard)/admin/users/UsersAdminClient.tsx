'use client';

import { useState, useTransition } from 'react';
import { createInvitation, revokeInvitation, toggleUserActive, changeUserRole } from '@/actions/admin';
import type { OrgUser, UserInvitation } from '@/actions/admin';

type Props = {
  initialUsers:       OrgUser[];
  initialInvitations: UserInvitation[];
};

const ROLES = ['SUPER_ADMIN', 'BRANCH_ADMIN', 'ACCOUNTANT', 'SALES_MANAGER', 'STOCK_MANAGER', 'FMS_COMPLIANCE', 'VIEWER'];

const ROLE_COLORS: Record<string, string> = {
  SUPER_ADMIN:    'bg-purple-100 text-purple-800',
  BRANCH_ADMIN:   'bg-blue-100 text-blue-800',
  ACCOUNTANT:     'bg-teal-100 text-teal-700',
  SALES_MANAGER:  'bg-amber-100 text-amber-800',
  STOCK_MANAGER:  'bg-indigo-100 text-indigo-700',
  FMS_COMPLIANCE: 'bg-emerald-100 text-emerald-700',
  VIEWER:         'bg-slate-100 text-slate-600',
};

const STATUS_COLORS: Record<string, string> = {
  PENDING:  'bg-amber-100 text-amber-700',
  ACCEPTED: 'bg-emerald-100 text-emerald-700',
  EXPIRED:  'bg-slate-100 text-slate-500',
  REVOKED:  'bg-red-100 text-red-600',
};

export default function UsersAdminClient({ initialUsers, initialInvitations }: Props) {
  const [users, setUsers]             = useState<OrgUser[]>(initialUsers);
  const [invitations, setInvitations] = useState<UserInvitation[]>(initialInvitations);
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole]   = useState('VIEWER');
  const [msg, setMsg]                 = useState('');
  const [isPending, startTransition]  = useTransition();

  function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    setMsg('');
    if (!inviteEmail.includes('@')) { setMsg('Enter a valid email address.'); return; }
    startTransition(async () => {
      const result = await createInvitation(inviteEmail, inviteRole);
      if (result.error) { setMsg('Error: ' + result.error); return; }
      const created = result.data as UserInvitation | undefined;
      setMsg(created?.invite_token
        ? `Invitation created for ${inviteEmail}. Copy the link from the Invitations table and send it to them (the app does not send emails itself).`
        : `Invitation created for ${inviteEmail}.`);
      if (created?.invite_token) void copyInviteLink(created.invite_token, false);
      setShowInviteForm(false);
      setInviteEmail(''); setInviteRole('VIEWER');
      if (result.data) setInvitations(prev => [result.data as UserInvitation, ...prev]);
    });
  }

  async function copyInviteLink(token: string, announce = true) {
    const link = `${window.location.origin}/invite/${token}`;
    try { await navigator.clipboard.writeText(link); if (announce) setMsg('Invitation link copied. Send it to the invited person.'); }
    catch { setMsg(`Copy this link and send it to the invited person: ${link}`); }
  }

  function mailtoFor(inv: UserInvitation) {
    const link = `${window.location.origin}/invite/${inv.invite_token}`;
    const body = `You have been invited to FertiLedger ERP as ${inv.role_name}.\n\nOpen this link to create your account (valid until ${inv.expires_at?.slice(0, 10)}):\n${link}`;
    return `mailto:${encodeURIComponent(inv.email)}?subject=${encodeURIComponent('Your FertiLedger ERP invitation')}&body=${encodeURIComponent(body)}`;
  }

  function handleRevoke(id: string) {
    startTransition(async () => {
      const result = await revokeInvitation(id);
      if (result.error) { setMsg('Error: ' + result.error); return; }
      setInvitations(prev => prev.map(i => i.id === id ? { ...i, status: 'REVOKED' as const } : i));
      setMsg('Invitation revoked.');
    });
  }

  function handleToggleActive(profileId: string, current: boolean) {
    startTransition(async () => {
      const result = await toggleUserActive(profileId, !current);
      if (result.error) { setMsg('Error: ' + result.error); return; }
      setUsers(prev => prev.map(u => u.user_profile_id === profileId ? { ...u, is_active: !current } : u));
    });
  }

  function handleRoleChange(profileId: string, newRole: string) {
    startTransition(async () => {
      const result = await changeUserRole(profileId, newRole);
      if (result.error) { setMsg('Error: ' + result.error); return; }
      setUsers(prev => prev.map(u => u.user_profile_id === profileId ? { ...u, role_name: newRole } : u));
      setMsg('Role updated.');
    });
  }

  const activeCount   = users.filter(u => u.is_active).length;
  const pendingInvites = invitations.filter(i => i.status === 'PENDING').length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex gap-4">
          <div className="bg-white border border-slate-200 rounded-xl px-4 py-3">
            <p className="text-xs text-slate-500">Active Users</p>
            <p className="text-2xl font-bold text-slate-900">{activeCount}</p>
          </div>
          <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
            <p className="text-xs text-slate-500">Pending Invites</p>
            <p className="text-2xl font-bold text-amber-700">{pendingInvites}</p>
          </div>
        </div>
        <button
          onClick={() => { setShowInviteForm(s => !s); setMsg(''); }}
          className="px-4 py-2 bg-green-700 text-white text-sm font-medium rounded-lg hover:bg-green-800">
          + Invite User
        </button>
      </div>

      {msg && (
        <div className={`text-sm px-4 py-3 rounded-lg border ${msg.startsWith('Error') ? 'bg-red-50 border-red-200 text-red-700' : 'bg-emerald-50 border-emerald-200 text-emerald-800'}`}>
          {msg}
        </div>
      )}

      {/* Invite Form */}
      {showInviteForm && (
        <div className="bg-white rounded-xl border border-slate-200 p-5">
          <h3 className="font-semibold text-slate-800 mb-4">Invite a New User</h3>
          <form onSubmit={handleInvite} className="flex items-end gap-3">
            <div className="flex-1">
              <label className="block text-xs font-medium text-slate-500 mb-1">Email Address</label>
              <input type="email" value={inviteEmail} onChange={e => setInviteEmail(e.target.value)}
                placeholder="user@example.com" required
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500" />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Role</label>
              <select value={inviteRole} onChange={e => setInviteRole(e.target.value)}
                className="text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500">
                {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <button type="submit" disabled={isPending}
              className="px-5 py-2 bg-green-700 text-white text-sm font-medium rounded-lg hover:bg-green-800 disabled:opacity-50">
              {isPending ? 'Creating...' : 'Create invitation'}
            </button>
            <button type="button" onClick={() => setShowInviteForm(false)}
              className="px-4 py-2 bg-slate-100 text-slate-700 text-sm rounded-lg hover:bg-slate-200">
              Cancel
            </button>
          </form>
        </div>
      )}

      {/* Users Table */}
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-100">
          <span className="font-semibold text-slate-800">Team Members</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Name</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Email</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Phone</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Role</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Joined</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Status</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {users.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-10 text-center text-slate-400">No users found</td></tr>
              ) : (
                users.map(u => (
                  <tr key={u.user_profile_id} className={`hover:bg-slate-50 ${!u.is_active ? 'opacity-50' : ''}`}>
                    <td className="px-4 py-3 font-medium text-slate-800">{u.full_name ?? '—'}</td>
                    <td className="px-4 py-3 text-slate-600 text-xs">{u.email}</td>
                    <td className="px-4 py-3 text-slate-500 text-xs">{u.phone ?? '—'}</td>
                    <td className="px-4 py-3">
                      <select
                        value={u.role_name}
                        onChange={e => handleRoleChange(u.user_profile_id, e.target.value)}
                        disabled={isPending}
                        className={`text-xs font-medium px-2 py-1 rounded border-0 focus:outline-none focus:ring-1 focus:ring-green-500 ${ROLE_COLORS[u.role_name] ?? 'bg-slate-100'}`}
                      >
                        {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">{u.joined_at?.slice(0, 10)}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${u.is_active ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                        {u.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => handleToggleActive(u.user_profile_id, u.is_active)}
                        disabled={isPending}
                        className={`text-xs underline disabled:opacity-50 ${u.is_active ? 'text-red-500 hover:text-red-700' : 'text-emerald-600 hover:text-emerald-800'}`}
                      >
                        {u.is_active ? 'Deactivate' : 'Activate'}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Invitations Table */}
      {invitations.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100">
            <span className="font-semibold text-slate-800">Invitations</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 border-b border-slate-200">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Email</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Role</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Status</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Expires</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-slate-600">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {invitations.map(inv => (
                  <tr key={inv.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3 text-slate-700">{inv.email}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${ROLE_COLORS[inv.role_name] ?? 'bg-slate-100'}`}>
                        {inv.role_name}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex px-2 py-0.5 rounded text-xs font-medium ${STATUS_COLORS[inv.status]}`}>
                        {inv.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">{inv.expires_at?.slice(0, 10)}</td>
                    <td className="px-4 py-3">
                      {inv.status === 'PENDING' && inv.invite_token && (
                        <span className="mr-3 inline-flex gap-3">
                          <button onClick={() => copyInviteLink(inv.invite_token!)} className="text-xs text-emerald-700 hover:text-emerald-900 underline">Copy link</button>
                          <a href={mailtoFor(inv)} className="text-xs text-emerald-700 hover:text-emerald-900 underline">Email it</a>
                        </span>
                      )}
                      {inv.status === 'PENDING' && (
                        <button onClick={() => handleRevoke(inv.id)} disabled={isPending}
                          className="text-xs text-red-500 hover:text-red-700 underline disabled:opacity-50">
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
