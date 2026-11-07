'use client';

import React, { useEffect, useState, useTransition } from 'react';
import { Truck, Plus, Search, Building2, Phone, FileCheck2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import {
  getTransporters,
  createTransporter,
  type CreateTransporterInput,
} from '@/actions/logistics';

interface TransporterRow {
  id: string;
  transporter_code: string;
  legal_name: string;
  trade_name: string | null;
  gstin: string | null;
  pan: string | null;
  contact_person: string | null;
  mobile: string | null;
  state_code: string | null;
  is_active: boolean;
}

export default function TransportersPage() {
  const [transporters, setTransporters] = useState<TransporterRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [isPending, startTransition] = useTransition();

  const [form, setForm] = useState<CreateTransporterInput>({
    transporter_code: '',
    legal_name: '',
    trade_name: '',
    gstin: '',
    pan: '',
    contact_person: '',
    mobile: '',
    address: '',
    state_code: '19', // Default West Bengal
  });

  async function loadData() {
    try {
      setLoading(true);
      const data = await getTransporters();
      setTransporters(data as TransporterRow[]);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : 'Failed to load transporters');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await createTransporter(form);
      if (!res.success) {
        toast.error(res.error || 'Could not create transporter');
        return;
      }
      toast.success('Transporter registered');
      setShowModal(false);
      setForm({
        transporter_code: '',
        legal_name: '',
        trade_name: '',
        gstin: '',
        pan: '',
        contact_person: '',
        mobile: '',
        address: '',
        state_code: '19',
      });
      await loadData();
    });
  }

  const filtered = transporters.filter(
    (t) =>
      t.legal_name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      t.transporter_code.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (t.gstin && t.gstin.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  return (
    <div className="min-h-screen bg-[#F8FAFC] p-6 text-[#0F172A]">
      {/* Header */}
      <div className="mb-6 flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <div className="flex items-center gap-2">
            <Truck className="h-6 w-6 text-[#15803D]" />
            <h1 className="text-2xl font-bold tracking-tight text-[#0F172A]">
              Transporters & Logistics Partners
            </h1>
          </div>
          <p className="mt-1 text-sm text-[#475569]">
            Manage registered freight carriers and Transporter IDs (TRANSIN/GSTIN) for E-Way Bill Part B compliance.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={loadData}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-[#475569] hover:bg-slate-50"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
          <button
            onClick={() => setShowModal(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-[#15803D] px-4 py-2 text-sm font-semibold text-white hover:bg-green-800"
          >
            <Plus className="h-4 w-4" />
            Add Transporter
          </button>
        </div>
      </div>

      {/* Search & KPI Bar */}
      <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        <div className="relative md:col-span-2">
          <Search className=" absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <input
            type="text"
            placeholder="Search by transporter name, code, or GSTIN..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-lg border border-slate-300 bg-white py-2 pl-10 pr-4 text-sm focus:border-[#15803D] focus:outline-none"
          />
        </div>
        <div className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-4 py-2.5">
          <span className="text-sm font-medium text-[#475569]">Active Transporters</span>
          <span className="rounded-full bg-green-100 px-3 py-0.5 text-sm font-bold text-[#15803D]">
            {transporters.length}
          </span>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-200 bg-slate-50 text-xs font-semibold uppercase text-[#475569]">
              <tr>
                <th className="px-4 py-3.5">Code</th>
                <th className="px-4 py-3.5">Legal / Trade Name</th>
                <th className="px-4 py-3.5">Transporter GSTIN / ID</th>
                <th className="px-4 py-3.5">PAN</th>
                <th className="px-4 py-3.5">Contact Person</th>
                <th className="px-4 py-3.5">State</th>
                <th className="px-4 py-3.5">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {loading ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-400">
                    Loading transporters...
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-500">
                    No transporters found. Click &ldquo;Add Transporter&rdquo; to register one.
                  </td>
                </tr>
              ) : (
                filtered.map((t) => (
                  <tr key={t.id} className="hover:bg-slate-50/80">
                    <td className="px-4 py-3 font-mono text-xs font-semibold text-[#0F172A]">
                      {t.transporter_code}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-[#0F172A]">{t.legal_name}</div>
                      {t.trade_name && (
                        <div className="text-xs text-[#475569]">{t.trade_name}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">
                      {t.gstin ? (
                        <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-0.5 font-medium text-slate-800">
                          <FileCheck2 className="h-3.5 w-3.5 text-[#15803D]" />
                          {t.gstin}
                        </span>
                      ) : (
                        <span className="text-slate-400">Unregistered</span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-[#475569]">
                      {t.pan || '—'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-sm text-[#0F172A]">{t.contact_person || '—'}</div>
                      {t.mobile && (
                        <div className="flex items-center gap-1 text-xs text-[#475569]">
                          <Phone className="h-3 w-3" /> {t.mobile}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-[#475569]">{t.state_code || '—'}</td>
                    <td className="px-4 py-3">
                      <span className="inline-flex rounded-full bg-green-50 px-2.5 py-0.5 text-xs font-medium text-[#15803D]">
                        Active
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Add Transporter Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4">
          <div className="w-full max-w-lg rounded-xl bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between border-b border-slate-200 pb-3">
              <div className="flex items-center gap-2">
                <Building2 className="h-5 w-5 text-[#15803D]" />
                <h2 className="text-lg font-bold text-[#0F172A]">Register Transporter</h2>
              </div>
              <button
                onClick={() => setShowModal(false)}
                className="text-sm text-slate-400 hover:text-slate-600"
              >
                ✕
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase text-[#475569]">
                    Transporter Code *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. TRN-001"
                    value={form.transporter_code}
                    onChange={(e) => setForm({ ...form, transporter_code: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm uppercase"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase text-[#475569]">
                    State Code
                  </label>
                  <input
                    type="text"
                    placeholder="19 (West Bengal)"
                    value={form.state_code ?? ''}
                    onChange={(e) => setForm({ ...form, state_code: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold uppercase text-[#475569]">
                  Legal Name *
                </label>
                <input
                  type="text"
                  required
                  placeholder="Registered Transport Company Name"
                  value={form.legal_name}
                  onChange={(e) => setForm({ ...form, legal_name: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase text-[#475569]">
                    GSTIN / TRANSIN (15 chars)
                  </label>
                  <input
                    type="text"
                    maxLength={15}
                    placeholder="19AAAAA0000A1Z5"
                    value={form.gstin ?? ''}
                    onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm uppercase"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase text-[#475569]">
                    PAN (10 chars)
                  </label>
                  <input
                    type="text"
                    maxLength={10}
                    placeholder="AAAAA0000A"
                    value={form.pan ?? ''}
                    onChange={(e) => setForm({ ...form, pan: e.target.value.toUpperCase() })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 font-mono text-sm uppercase"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase text-[#475569]">
                    Contact Person
                  </label>
                  <input
                    type="text"
                    placeholder="Dispatcher / Manager"
                    value={form.contact_person ?? ''}
                    onChange={(e) => setForm({ ...form, contact_person: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs font-semibold uppercase text-[#475569]">
                    Mobile Number
                  </label>
                  <input
                    type="text"
                    placeholder="9876543210"
                    value={form.mobile ?? ''}
                    onChange={(e) => setForm({ ...form, mobile: e.target.value })}
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-xs font-semibold uppercase text-[#475569]">
                  Office Address
                </label>
                <textarea
                  rows={2}
                  value={form.address ?? ''}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                  className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
                />
              </div>

              <div className="flex justify-end gap-3 border-t border-slate-200 pt-4">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-[#475569]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isPending}
                  className="rounded-lg bg-[#15803D] px-5 py-2 text-sm font-semibold text-white hover:bg-green-800 disabled:opacity-50"
                >
                  {isPending ? 'Saving...' : 'Save Transporter'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}