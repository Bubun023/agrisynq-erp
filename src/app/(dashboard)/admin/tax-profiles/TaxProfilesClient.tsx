"use client";
// TaxProfilesClient.tsx — interactive client for GST Rate Master (Tax Profiles).
// Live CGST/SGST/IGST calculation from gst_rate. Quick-select GST rate buttons.

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useFormState, useFormStatus } from "react-dom";
import { toast } from "sonner";
import { Plus, Search, X, Receipt, Pencil } from "lucide-react";
import {
  addTaxProfile,
  updateTaxProfile,
  type TaxProfileFormState,
} from "@/actions/tax-profiles";
import { formatDate } from "@/lib/utils";

// ─── Types ─────────────────────────────────────────────────────
type TaxProfile = {
  id: string;
  product_category: string | null;
  hsn_code: string;
  description: string | null;
  gst_rate: number;
  cgst_rate: number;
  sgst_rate: number;
  igst_rate: number;
  cess_rate: number;
  is_exempt: boolean;
  is_nil_rated: boolean;
  effective_from: string;
  effective_to: string | null;
  is_active: boolean;
};

interface Props {
  initialData: TaxProfile[];
}

// ─── GST Quick-select Rates ────────────────────────────────────
const GST_RATES = [0, 5, 12, 18, 28];

// ─── Submit Button ─────────────────────────────────────────────
function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className="btn btn-primary w-full" aria-busy={pending}>
      {pending ? "Saving…" : label}
    </button>
  );
}

// ─── Toggle ────────────────────────────────────────────────────
function Toggle({
  name, label, checked, onChange,
}: {
  name: string; label: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between text-sm cursor-pointer select-none">
      <span className="text-ink">{label}</span>
      <div className="flex items-center gap-2">
        <input type="hidden" name={name} value={checked ? "true" : "false"} />
        <button
          type="button"
          onClick={() => onChange(!checked)}
          role="switch"
          aria-checked={checked}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${checked ? "bg-leaf-600" : "bg-surface-border"}`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${checked ? "translate-x-4" : "translate-x-0.5"}`} />
        </button>
      </div>
    </label>
  );
}

// ─── Slide-over Form ───────────────────────────────────────────
const INIT: TaxProfileFormState = {};

const PRODUCT_CATEGORIES = [
  "FERTILIZER", "PESTICIDE", "SEED", "OTHER",
  "MICRONUTRIENT", "BIO_FERTILIZER", "PLANT_GROWTH",
  "WEEDICIDE", "FUNGICIDE", "INSECTICIDE", "RODENTICIDE", "ADJUVANT",
];

function TaxProfileSlideOver({
  isOpen,
  editItem,
  onClose,
}: {
  isOpen: boolean;
  editItem: TaxProfile | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const [gstRate, setGstRate] = useState<number>(editItem?.gst_rate ?? 5);
  const [isExempt, setIsExempt] = useState(false);
  const [isNilRated, setIsNilRated] = useState(false);

  useEffect(() => {
    setGstRate(editItem?.gst_rate ?? 5);
    setIsExempt(editItem?.is_exempt ?? false);
    setIsNilRated(editItem?.is_nil_rated ?? false);
  }, [editItem, isOpen]);

  const boundAction = editItem ? updateTaxProfile.bind(null, editItem.id) : addTaxProfile;
  const [state, formAction] = useFormState(boundAction, INIT);

  useEffect(() => {
    if (state.success) {
      toast.success(editItem ? "Tax profile updated" : "Tax profile added");
      router.refresh();
      onClose();
    }
    if (state.error) toast.error(state.error);
  }, [state]);

  const fe = state.fieldErrors ?? {};
  const half = gstRate / 2;

  return (
    <>
      {isOpen && (
        <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} aria-hidden="true" />
      )}
      <div
        className={`fixed inset-y-0 right-0 w-[480px] bg-white shadow-xl z-50 flex flex-col transform transition-transform duration-300 ${isOpen ? "translate-x-0" : "translate-x-full"}`}
        role="dialog"
        aria-modal="true"
        aria-label={editItem ? "Edit Tax Profile" : "Add Tax Profile"}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-border shrink-0">
          <h2 className="text-base font-semibold text-ink">
            {editItem ? "Edit Tax Profile" : "Add Tax Profile"}
          </h2>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-surface-subtle text-ink-muted" aria-label="Close">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-5">
          <form action={formAction} className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="form-label" htmlFor="tp-cat">Product Category</label>
                <select id="tp-cat" name="product_category" defaultValue={editItem?.product_category ?? ""} className="input w-full">
                  <option value="">— All —</option>
                  {PRODUCT_CATEGORIES.map((c) => (
                    <option key={c} value={c}>{c.replace(/_/g, " ")}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="form-label" htmlFor="tp-hsn">
                  HSN Code <span className="text-danger-600">*</span>
                </label>
                <input
                  id="tp-hsn"
                  name="hsn_code"
                  defaultValue={editItem?.hsn_code ?? ""}
                  className="input w-full font-mono"
                  required
                  placeholder="3102"
                  minLength={4}
                  maxLength={8}
                />
                {fe.hsn_code && <p className="form-error">{fe.hsn_code[0]}</p>}
              </div>
            </div>

            <div>
              <label className="form-label" htmlFor="tp-desc">Description</label>
              <input id="tp-desc" name="description" defaultValue={editItem?.description ?? ""} className="input w-full" placeholder="Urea (Fertilizer)" />
            </div>

            {/* GST Rate Quick-select */}
            <div>
              <label className="form-label">
                GST Rate % <span className="text-danger-600">*</span>
              </label>
              <div className="flex gap-2 flex-wrap">
                {GST_RATES.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setGstRate(r)}
                    className={`px-4 py-1.5 rounded-md text-sm font-medium border transition-colors ${
                      gstRate === r
                        ? "bg-navy-900 text-white border-navy-900"
                        : "bg-white text-ink border-surface-border hover:border-navy-300"
                    }`}
                  >
                    {r}%
                  </button>
                ))}
                <div className="flex-1 min-w-[80px]">
                  <input
                    name="gst_rate"
                    type="number"
                    min={0}
                    max={100}
                    step={0.01}
                    value={gstRate}
                    onChange={(e) => setGstRate(Number(e.target.value))}
                    className="input w-full"
                    aria-label="Custom GST rate"
                  />
                </div>
              </div>

              {/* Live CGST/SGST/IGST preview */}
              <div className="mt-3 grid grid-cols-3 gap-2 rounded-lg bg-surface-subtle px-3 py-2 text-xs">
                <div className="text-center">
                  <p className="text-ink-muted font-medium">CGST</p>
                  <p className="text-lg font-semibold text-ink tabular-nums">{half.toFixed(2)}%</p>
                </div>
                <div className="text-center border-x border-surface-border">
                  <p className="text-ink-muted font-medium">SGST</p>
                  <p className="text-lg font-semibold text-ink tabular-nums">{half.toFixed(2)}%</p>
                </div>
                <div className="text-center">
                  <p className="text-ink-muted font-medium">IGST</p>
                  <p className="text-lg font-semibold text-ink tabular-nums">{gstRate.toFixed(2)}%</p>
                </div>
              </div>
            </div>

            <div>
              <label className="form-label" htmlFor="tp-cess">Cess Rate %</label>
              <input id="tp-cess" name="cess_rate" type="number" min={0} step={0.01} defaultValue={editItem?.cess_rate ?? 0} className="input w-full" />
            </div>

            <div className="space-y-3 rounded-lg border border-surface-border bg-surface-subtle p-4">
              <Toggle name="is_exempt" label="Exempt from GST" checked={isExempt} onChange={setIsExempt} />
              <Toggle name="is_nil_rated" label="Nil Rated" checked={isNilRated} onChange={setIsNilRated} />
              {(isExempt || isNilRated) && (
                <div>
                  <label className="form-label" htmlFor="tp-reason">Exemption Reason</label>
                  <input id="tp-reason" name="exemption_reason" className="input w-full" placeholder="Schedule I, Sr. No. 2" />
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="form-label" htmlFor="tp-from">
                  Effective From <span className="text-danger-600">*</span>
                </label>
                <input id="tp-from" name="effective_from" type="date" defaultValue={editItem?.effective_from ?? ""} className="input w-full" required />
                {fe.effective_from && <p className="form-error">{fe.effective_from[0]}</p>}
              </div>
              <div>
                <label className="form-label" htmlFor="tp-to">Effective To</label>
                <input id="tp-to" name="effective_to" type="date" defaultValue={editItem?.effective_to ?? ""} className="input w-full" />
                {fe.effective_to && <p className="form-error">{fe.effective_to[0]}</p>}
              </div>
            </div>

            <div className="pt-2">
              <SubmitButton label={editItem ? "Update Profile" : "Add Profile"} />
            </div>
          </form>
        </div>
      </div>
    </>
  );
}

// ─── Main Client Component ─────────────────────────────────────
export default function TaxProfilesClient({ initialData }: Props) {
  const [search, setSearch] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [editItem, setEditItem] = useState<TaxProfile | null>(null);

  const openAdd = useCallback(() => { setEditItem(null); setIsOpen(true); }, []);
  const openEdit = useCallback((t: TaxProfile) => { setEditItem(t); setIsOpen(true); }, []);
  const closePanel = useCallback(() => setIsOpen(false), []);

  const filtered = initialData.filter(
    (t) =>
      t.hsn_code.includes(search) ||
      (t.description ?? "").toLowerCase().includes(search.toLowerCase()) ||
      (t.product_category ?? "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <div className="page-header">
        <div>
          <h1 className="page-title">Tax Profiles — GST Rate Master</h1>
          <p className="page-subtitle">HSN-wise GST rates, CGST/SGST/IGST splits and cess rates</p>
        </div>
        <button onClick={openAdd} className="btn btn-primary inline-flex items-center gap-2">
          <Plus className="w-4 h-4" /> Add Profile
        </button>
      </div>

      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by HSN, description or category…"
          className="w-full pl-9 pr-4 py-2 bg-white border border-surface-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-leaf-500/20 focus:border-leaf-500 placeholder:text-ink-faint shadow-sm"
          aria-label="Search tax profiles"
        />
      </div>

      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>HSN Code</th>
                <th>Description</th>
                <th>Category</th>
                <th className="text-right">GST%</th>
                <th className="text-right">CGST%</th>
                <th className="text-right">SGST%</th>
                <th className="text-right">IGST%</th>
                <th className="text-right">Cess%</th>
                <th>Exempt</th>
                <th>Effective From</th>
                <th>Effective To</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={12} className="py-16 text-center">
                    <Receipt className="mx-auto mb-3 h-10 w-10 text-ink-faint" />
                    <p className="text-sm font-medium text-ink">
                      {search ? "No tax profiles match your search" : "No tax profiles configured"}
                    </p>
                    {!search && (
                      <button onClick={openAdd} className="mt-3 text-xs text-leaf-600 hover:underline">
                        Add your first tax profile
                      </button>
                    )}
                  </td>
                </tr>
              ) : (
                filtered.map((t) => (
                  <tr key={t.id}>
                    <td className="font-mono font-medium text-navy-700">{t.hsn_code}</td>
                    <td className="max-w-[160px] truncate text-ink">{t.description ?? "—"}</td>
                    <td>
                      {t.product_category ? (
                        <span className="badge badge-gray">{t.product_category.replace(/_/g, " ")}</span>
                      ) : (
                        <span className="text-ink-faint">—</span>
                      )}
                    </td>
                    <td className="text-right tabular-nums font-medium">{t.gst_rate}%</td>
                    <td className="text-right tabular-nums text-ink-muted">{t.cgst_rate}%</td>
                    <td className="text-right tabular-nums text-ink-muted">{t.sgst_rate}%</td>
                    <td className="text-right tabular-nums text-ink-muted">{t.igst_rate}%</td>
                    <td className="text-right tabular-nums text-ink-muted">{t.cess_rate}%</td>
                    <td>
                      {t.is_exempt ? (
                        <span className="badge badge-gold">Exempt</span>
                      ) : t.is_nil_rated ? (
                        <span className="badge badge-memo">Nil</span>
                      ) : (
                        <span className="badge badge-green">Taxable</span>
                      )}
                    </td>
                    <td className="text-ink-muted text-xs">{formatDate(t.effective_from)}</td>
                    <td className="text-ink-muted text-xs">{t.effective_to ? formatDate(t.effective_to) : "—"}</td>
                    <td>
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => openEdit(t)}
                          className="p-1.5 rounded hover:bg-surface-subtle text-ink-muted hover:text-ink transition-colors"
                          aria-label={`Edit ${t.hsn_code}`}
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
            {filtered.length} of {initialData.length} profiles
          </div>
        )}
      </div>

      <TaxProfileSlideOver isOpen={isOpen} editItem={editItem} onClose={closePanel} />
    </div>
  );
}
