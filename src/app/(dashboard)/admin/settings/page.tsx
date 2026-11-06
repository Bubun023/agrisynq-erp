import { Suspense } from 'react';
import { getOrgSettings } from '@/actions/admin';
import OrgSettingsClient from './OrgSettingsClient';

export const metadata = { title: 'Organisation Settings | FertiLedger ERP' };
export const dynamic = 'force-dynamic';

export default async function OrgSettingsPage() {
  const settings = await getOrgSettings();

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Organisation Settings</h1>
        <p className="text-sm text-slate-500 mt-1">
          Manage your organisation profile, GST details, licence numbers and invoice configuration
        </p>
      </div>

      <Suspense fallback={<div className="text-slate-400 text-sm">Loading settings...</div>}>
        <OrgSettingsClient initialSettings={settings} />
      </Suspense>
    </div>
  );
}
