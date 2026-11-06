'use client';

import { useState, useTransition } from 'react';
import { saveOrgSettings } from '@/actions/admin';

type Props = { initialSettings: Record<string, string> };

const SETTINGS_FIELDS = [
  { key: 'org_name',         label: 'Organisation Name',  type: 'text',   placeholder: 'FertiLedger Agri Pvt Ltd' },
  { key: 'org_gstin',        label: 'GSTIN',              type: 'text',   placeholder: '27AABCU9603R1ZX' },
  { key: 'org_pan',          label: 'PAN',                type: 'text',   placeholder: 'AABCU9603R' },
  { key: 'org_address',      label: 'Registered Address', type: 'text',   placeholder: 'Plot No 1, MIDC, Pune' },
  { key: 'org_state',        label: 'State',              type: 'text',   placeholder: 'Maharashtra' },
  { key: 'org_state_code',   label: 'State Code',         type: 'text',   placeholder: '27' },
  { key: 'org_pincode',      label: 'Pincode',            type: 'text',   placeholder: '411001' },
  { key: 'org_phone',        label: 'Phone',              type: 'tel',    placeholder: '+91 98765 43210' },
  { key: 'org_email',        label: 'Email',              type: 'email',  placeholder: 'accounts@company.com' },
  { key: 'fms_license_no',   label: 'FMS License No',     type: 'text',   placeholder: 'FMS/MH/2023/001' },
  { key: 'cf_license_no',    label: 'C&F License No',     type: 'text',   placeholder: 'CF/MH/2023/001' },
  { key: 'bank_account_name',label: 'Default Bank Name',  type: 'text',   placeholder: 'SBI Current A/c' },
  { key: 'invoice_prefix',   label: 'Invoice Prefix',     type: 'text',   placeholder: 'FL' },
  { key: 'fy_start_month',   label: 'FY Start Month',     type: 'number', placeholder: '4 (April)' },
  { key: 'invoice_footer',   label: 'Invoice Footer Note',type: 'text',   placeholder: 'Thank you for your business' },
];

export default function OrgSettingsClient({ initialSettings }: Props) {
  const [settings, setSettings]     = useState<Record<string, string>>(initialSettings);
  const [msg, setMsg]               = useState('');
  const [isPending, startTransition] = useTransition();
  const [isDirty, setIsDirty]       = useState(false);

  function handleChange(key: string, value: string) {
    setSettings(prev => ({ ...prev, [key]: value }));
    setIsDirty(true);
  }

  function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setMsg('');
    startTransition(async () => {
      const result = await saveOrgSettings(settings);
      if (result.error) { setMsg('Error: ' + result.error); return; }
      setMsg('Settings saved successfully.');
      setIsDirty(false);
    });
  }

  return (
    <div className="space-y-4">
      {msg && (
        <div className={`text-sm px-4 py-3 rounded-lg border ${msg.startsWith('Error') ? 'bg-red-50 border-red-200 text-red-700' : 'bg-emerald-50 border-emerald-200 text-emerald-800'}`}>
          {msg}
        </div>
      )}

      <form onSubmit={handleSave}>
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between">
            <div>
              <h2 className="font-semibold text-slate-800">Organisation Settings</h2>
              <p className="text-xs text-slate-500 mt-0.5">Used on invoices, GST returns and compliance documents</p>
            </div>
            {isDirty && (
              <span className="text-xs text-amber-600 font-medium bg-amber-50 px-2 py-1 rounded">Unsaved changes</span>
            )}
          </div>

          <div className="p-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            {SETTINGS_FIELDS.map(f => (
              <div key={f.key}>
                <label className="block text-xs font-medium text-slate-500 mb-1">{f.label}</label>
                <input
                  type={f.type}
                  value={settings[f.key] ?? ''}
                  onChange={e => handleChange(f.key, e.target.value)}
                  placeholder={f.placeholder}
                  className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500"
                />
              </div>
            ))}
          </div>

          <div className="px-6 py-4 border-t border-slate-100 bg-slate-50 flex items-center gap-3">
            <button type="submit" disabled={isPending || !isDirty}
              className="px-6 py-2 bg-green-700 text-white text-sm font-medium rounded-lg hover:bg-green-800 disabled:opacity-50">
              {isPending ? 'Saving...' : 'Save Settings'}
            </button>
            {isDirty && (
              <button type="button" onClick={() => { setSettings(initialSettings); setIsDirty(false); setMsg(''); }}
                className="px-4 py-2 bg-white border border-slate-200 text-slate-600 text-sm rounded-lg hover:bg-slate-50">
                Discard Changes
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}
