"use client";
// LicencesClient.tsx — interactive client for Licences master data.
// Expiry highlighting: RED if expired, AMBER ≤30 days, GREEN if valid.

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useFormState, useFormStatus } from "react-dom";
import { toast } from "sonner";
import { Plus, Search, X, FileCheck, Pencil, AlertTriangle } from "lucide-react";
import {
  addLicence,
  updateLicence,
  type LicenceFormState,
} from "@/actions/licences";
import { formatDate, daysUntil } from "@/lib/utils";

// ─── Types ─────────────────────────────────────────────────────
type Licence = {
  id: string;
  licence_number: string;
  licence_type: string;
  entity_type: string;
  entity_id: string | null;
  valid_from: string;
  valid_to: string;
  issuing_authority: string | null;
  approved_categories: string[];
  status: string;
  is_active: boolean;
  created_at: string;
};

interface Props {
  initialData: Licence[];
}

// ─── Expiry Cell ───────────────────────────────────────────────
function ExpiryCell({ validTo }: { validTo: string }) {
  const days = daysUntil(validTo);
  if (days === null) return <span className="text-ink-muted">{formatDate(validTo)}</span>;

  if (days < 0) {
    return (
      <div className="flex items-center gap-1.5">
        <span className="font-medium text-danger-600">{formatDate(validTo)}</span>
        <span className="badge badge-red">Expired</span>
      </div>
    );
  }
  if (days <= 30) {
    return (
      <div className="flex items-center gap-1.5">
        <span className="font-medium text-warning-600">{formatDate(validTo)}</span>
        <span className="badge badge-gold">{days}d left</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-ink">{formatDate(validTo)}</span>
      <span className="badge badge-green">{days}d left</span>
    </div>
  );
}

// ─── Status Badge ──────────────────────────────────────────────
function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    ACTIVE:          "badge badge-green",
    EXPIRED:         "badge badge-red",
    SUSPENDED:       "badge badge-gold",
    CANCELLED:       "badge badge-red",
    PENDING_RENEWAL: "badge badge-memo",
  };
  return <span className={map[status] ?? "badge badge-gray"}>{status.replace(/_/g, " ")}</span>;
}

// ─── Submit Button ─────────────────────────────────────────────
function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="btn btn-primary w-full" aria-busy={pending}>
      {pending ? "Saving…" : label}
    </button>
  );
}

// ─── Slide-over Form ───────────────────────────────────────────
const INIT: LicenceFormState = {};

function LicenceSlideOver({
  isOpen,
  editItem,
  onClose,
}: {
  isOpen: boolean;
  editItem: Licence | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const boundAction = editItem ? updateLicence.bind(null, editItem.id) : addLicence;
  const [state, formAction] = useFormState(boundAction, INIT);

  useEffect(() => {
    if (state.success) {
      toast.success(editItem ? "Licence updated" : "Licence added");
      router.refresh();
      onClose();
    }
    if (state.error) toast.error(state.error);
  }, [state]);

  const fe = state.fieldErrors ?? {};

  return (
    <>
      {isOpen && (
        <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} aria-hidden="true" />
      )}
      <div
        className={`fixed inset-y-0 right-0 w-[480px] bg-white shadow-xl z-50 flex flex-col transform transition-transform duration-300 ${isOpen ? "translate-x-0" : "translate-x-full"}`}
        role="dialog"
        aria-modal="true"
        aria-label={editItem ? "Edit Licence" : "Add Licence"}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-border shrink-0">
          <h2 className="text-base font-semibold text-ink">
            {editItem ? "Edit Licence" : "Add Licence"}
          </h2>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-surface-subtle text-ink-muted" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          <form action={formAction} className="space-y-4">
            <div>
              <label className="form-label" htmlFor="lic-no">
                Licence Number <span className="text-danger-600">*</span>
              </label>
              <input
                id="lic-no"
                name="licence_number"
                defaultValue={editItem?.licence_number ?? ""}
                className="input w-full font-mono"
                required
                placeholder="MH/FERT/2024/001"
              />
              {fe.licence_number && <p className="form-error">{fe.licence_number[0]}</p>}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="form-label" htmlFor="lic-type">
                  Licence Type <span className="text-danger-600">*</span>
                </label>
                <select
                  id="lic-type"
                  name="licence_type"
                  defaultValue={editItem?.licence_type ?? "FERTILIZER"}
                  className="input w-full"
                  required
                >
                  {[
                    "FERTILIZER", "PESTICIDE", "SEED", "RETAIL",
                    "FERTILIZER_WHOLESALE", "FERTILIZER_RETAIL", "INSECTICIDE", "STORAGE"
                  ].map((t) => (
                    <option key={t} value={t}>{t.replace(/_/g, " ")}</option>
                  ))}
                </select>
                {fe.licence_type && <p className="form-error">{fe.licence_type[0]}</p>}
              </div>

              <div>
                <label className="form-label" htmlFor="lic-entity">Entity Type</label>
                <select
                  id="lic-entity"
                  name="entity_type"
                  defaultValue={editItem?.entity_type ?? "ORGANISATION"}
                  className="input w-full"
                >
                  <option value="ORGANISATION">Organisation</option>
                  <option value="PARTY">Party</option>
                  <option value="BRANCH">Branch</option>
                  <option value="LOCATION">Location</option>
                </select>
              </div>

              <div>
                <label className="form-label" htmlFor="lic-from">
                  Valid From <span className="text-danger-600">*</span>
                </label>
                <input
                  id="lic-from"
                  name="valid_from"
                  type="date"
                  defaultValue={editItem?.valid_from ?? ""}
                  className="input w-full"
                  required
                />
                {fe.valid_from && <p className="form-error">{fe.valid_from[0]}</p>}
              </div>

              <div>
                <label className="form-label" htmlFor="lic-to">
                  Valid To <span className="text-danger-600">*</span>
                </label>
                <input
                  id="lic-to"
                  name="valid_to"
                  type="date"
                  defaultValue={editItem?.valid_to ?? ""}
                  className="input w-full"
                  required
                />
                {fe.valid_to && <p className="form-error">{fe.valid_to[0]}</p>}
              </div>
            </div>

            <div>
              <label className="form-label" htmlFor="lic-authority">Issuing Authority</label>
              <input id="lic-authority" name="issuing_authority" defaultValue={editItem?.issuing_authority ?? ""} className="input w-full" placeholder="Dept. of Agriculture, Maharashtra" />
            </div>

            <div>
              <label className="form-label" htmlFor="lic-premises">Approved Premises</label>
              <textarea id="lic-premises" name="approved_premises" rows={2} className="input w-full" />
            </div>

            <div>
              <label className="form-label" htmlFor="lic-cats">Approved Categories</label>
              <input
                id="lic-cats"
                name="approved_categories"
                defaultValue={(editItem?.approved_categories ?? []).join(", ")}
                className="input w-full"
                placeholder="FERTILIZER, PESTICIDE (comma separated)"
              />
              <p className="form-hint">Comma-separated product categories covered by this licence</p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="form-label" htmlFor="lic-reminder">Renewal Reminder (days)</label>
                <input id="lic-reminder" name="renewal_reminder_days" type="number" min={1} max={180} defaultValue={30} className="input w-full" />
              </div>
              <div>
                <label className="form-label" htmlFor="lic-status">Status</label>
                <select
                  id="lic-status"
                  name="status"
                  defaultValue={editItem?.status ?? "ACTIVE"}
                  className="input w-full"
                >
                  <option value="ACTIVE">Active</option>
                  <option value="EXPIRED">Expired</option>
                  <option value="SUSPENDED">Suspended</option>
                  <option value="CANCELLED">Cancelled</option>
                  <option value="PENDING_RENEWAL">Pending Renewal</option>
                </select>
              </div>
            </div>

            <div className="pt-2">
              <SubmitButton label={editItem ? "Update Licence" : "Add Licence"} />
            </div>
          </form>
        </div>
      </div>
    </>
  );
}

// ─── Main Client Component ─────────────────────────────────────
export default function LicencesClient({ initialData }: Props) {
  const [search, setSearch] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [editItem, setEditItem] = useState<Licence | null>(null);

  const openAdd = useCallback(() => { setEditItem(null); setIsOpen(true); }, []);
  const openEdit = useCallback((l: Licence) => { setEditItem(l); setIsOpen(true); }, []);
  const closePanel = useCallback(() => setIsOpen(false), []);

  // Count expiring-soon for alert banner
  const expiringSoon = initialData.filter((l) => {
    const d = daysUntil(l.valid_to);
    return d !== null && d >= 0 && d <= 30 && l.status === "ACTIVE";
  }).length;

  const filtered = initialData.filter(
    (l) =>
      l.licence_number.toLowerCase().includes(search.toLowerCase()) ||
      l.licence_type.toLowerCase().includes(search.toLowerCase()) ||
      (l.issuing_authority ?? "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Licences</h1>
          <p className="page-subtitle">Regulatory licences — fertilizer, pesticide, seed, storage</p>
        </div>
        <button onClick={openAdd} className="btn btn-primary inline-flex items-center gap-2">
          <Plus className="w-4 h-4" /> Add Licence
        </button>
      </div>

      {/* Expiry warning banner */}
      {expiringSoon > 0 && (
        <div
          role="alert"
          className="flex items-center gap-3 rounded-lg border border-warning-300 bg-warning-50 px-4 py-3 text-sm text-warning-800"
        >
          <AlertTriangle className="h-4 w-4 shrink-0 text-warning-600" />
          <span>
            <strong>{expiringSoon}</strong> licence{expiringSoon !== 1 ? "s" : ""} expiring within 30 days. Renew promptly to avoid compliance risk.
          </span>
        </div>
      )}

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by number, type or authority…"
          className="w-full pl-9 pr-4 py-2 bg-white border border-surface-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-leaf-500/20 focus:border-leaf-500 placeholder:text-ink-faint shadow-sm"
          aria-label="Search licences"
        />
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Licence No.</th>
                <th>Type</th>
                <th>Entity</th>
                <th>Valid From</th>
                <th>Valid To</th>
                <th>Status</th>
                <th>Categories</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-16 text-center">
                    <FileCheck className="mx-auto mb-3 h-10 w-10 text-ink-faint" />
                    <p className="text-sm font-medium text-ink">
                      {search ? "No licences match your search" : "No licences recorded"}
                    </p>
                    {!search && (
                      <button onClick={openAdd} className="mt-3 text-xs text-leaf-600 hover:underline">
                        Add your first licence
                      </button>
                    )}
                  </td>
                </tr>
              ) : (
                filtered.map((l) => (
                  <tr key={l.id}>
                    <td className="font-mono text-sm font-medium text-navy-700">{l.licence_number}</td>
                    <td>
                      <span className="badge badge-navy">{l.licence_type.replace(/_/g, " ")}</span>
                    </td>
                    <td className="text-ink-muted text-xs">{l.entity_type}</td>
                    <td className="text-ink-muted text-xs">{formatDate(l.valid_from)}</td>
                    <td>
                      <ExpiryCell validTo={l.valid_to} />
                    </td>
                    <td>
                      <StatusBadge status={l.status} />
                    </td>
                    <td className="max-w-[160px]">
                      <p className="truncate text-xs text-ink-muted">
                        {l.approved_categories?.length ? l.approved_categories.join(", ") : "—"}
                      </p>
                    </td>
                    <td>
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => openEdit(l)}
                          className="p-1.5 rounded hover:bg-surface-subtle text-ink-muted hover:text-ink transition-colors"
                          aria-label={`Edit ${l.licence_number}`}
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {filtered.length > 0 && (
          <div className="border-t border-surface-border px-4 py-3 text-xs text-ink-muted">
            {filtered.length} of {initialData.length} licences
          </div>
        )}
      </div>

      <LicenceSlideOver isOpen={isOpen} editItem={editItem} onClose={closePanel} />
    </div>
  );
}
