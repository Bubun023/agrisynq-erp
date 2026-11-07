"use client";
// PartiesClient.tsx — interactive client component for Parties master data.
// Handles slide-over add/edit panel, archive, search, and toast notifications.

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useFormState, useFormStatus } from "react-dom";
import { toast } from "sonner";
import { Plus, Search, X, Users, Pencil, Archive } from "lucide-react";
import {
  addParty,
  updateParty,
  archiveParty,
  type PartyFormState,
} from "@/actions/parties";
import { formatCurrency } from "@/lib/utils";

// ─── Types ─────────────────────────────────────────────────────
type Party = {
  id: string;
  name: string;
  code: string | null;
  alias: string | null;
  party_type: string;
  is_customer: boolean;
  is_supplier: boolean;
  is_cf_agent: boolean;
  is_transporter: boolean;
  is_wholesaler_licensed: boolean;
  is_retailer_licensed: boolean;
  gstin: string | null;
  gst_status: string;
  phone: string | null;
  alt_phone: string | null;
  email: string | null;
  state: string | null;
  credit_limit: number;
  credit_days: number;
  fms_dealer_id: string | null;
  is_active: boolean;
  created_at: string;
};

interface Props {
  initialData: Party[];
}

// ─── GST Status Badge ──────────────────────────────────────────
function GstBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    REGULAR: "badge badge-green",
    COMPOSITION: "badge badge-gold",
    UNREGISTERED: "badge badge-gray",
    EXEMPT: "badge badge-memo",
    SUSPENDED: "badge badge-red",
    CANCELLED: "badge badge-red",
  };
  return <span className={map[status] ?? "badge badge-gray"}>{status}</span>;
}

// ─── Submit Button ─────────────────────────────────────────────
function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="btn btn-primary w-full"
      aria-busy={pending}
    >
      {pending ? "Saving…" : label}
    </button>
  );
}

// ─── Role Checkbox ─────────────────────────────────────────────
function RoleCheck({
  name,
  label,
  checked,
  onChange,
}: {
  name: string;
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
      <input
        type="checkbox"
        className="h-4 w-4 rounded border-surface-border text-leaf-600 focus:ring-leaf-500"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <input type="hidden" name={name} value={checked ? "true" : "false"} />
      {label}
    </label>
  );
}

// ─── Slide-over Form ───────────────────────────────────────────
const INIT: PartyFormState = {};

function PartySlideOver({
  isOpen,
  editItem,
  onClose,
}: {
  isOpen: boolean;
  editItem: Party | null;
  onClose: () => void;
}) {
  const router = useRouter();

  // Roles state (needed for checkbox → hidden input pattern)
  const [roles, setRoles] = useState({
    is_customer: false,
    is_supplier: false,
    is_cf_agent: false,
    is_transporter: false,
    is_wholesaler_licensed: false,
    is_retailer_licensed: false,
  });

  // Sync roles when editItem changes
  useEffect(() => {
    if (editItem) {
      setRoles({
        is_customer: editItem.is_customer,
        is_supplier: editItem.is_supplier,
        is_cf_agent: editItem.is_cf_agent,
        is_transporter: editItem.is_transporter,
        is_wholesaler_licensed: editItem.is_wholesaler_licensed,
        is_retailer_licensed: editItem.is_retailer_licensed,
      });
    } else {
      setRoles({ is_customer: true, is_supplier: false, is_cf_agent: false, is_transporter: false, is_wholesaler_licensed: false, is_retailer_licensed: false });
    }
  }, [editItem, isOpen]);

  const boundAction = editItem
    ? updateParty.bind(null, editItem.id)
    : addParty;

  const [state, formAction] = useFormState(boundAction, INIT);

  useEffect(() => {
    if (state.success) {
      toast.success(editItem ? "Party updated" : "Party added");
      router.refresh();
      onClose();
    }
    if (state.error) toast.error(state.error);
  }, [state]);

  const fe = state.fieldErrors ?? {};

  return (
    <>
      {/* Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/20 z-40"
          onClick={onClose}
          aria-hidden="true"
        />
      )}

      {/* Panel */}
      <div
        className={`fixed inset-y-0 right-0 w-[480px] bg-white shadow-xl z-50 flex flex-col transform transition-transform duration-300 ${isOpen ? "translate-x-0" : "translate-x-full"}`}
        aria-modal="true"
        role="dialog"
        aria-label={editItem ? "Edit Party" : "Add Party"}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-border shrink-0">
          <h2 className="text-base font-semibold text-ink">
            {editItem ? "Edit Party" : "Add Party"}
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-surface-subtle text-ink-muted"
            aria-label="Close panel"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        <div className="flex-1 overflow-y-auto px-6 py-5">
          <form action={formAction} className="space-y-4">
            {/* Name + Code */}
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="form-label" htmlFor="p-name">
                  Name <span className="text-danger-600">*</span>
                </label>
                <input
                  id="p-name"
                  name="name"
                  defaultValue={editItem?.name ?? ""}
                  className="input w-full"
                  required
                  placeholder="e.g. Ramesh Traders"
                />
                {fe.name && <p className="form-error">{fe.name[0]}</p>}
              </div>
              <div>
                <label className="form-label" htmlFor="p-code">Code</label>
                <input
                  id="p-code"
                  name="code"
                  defaultValue={editItem?.code ?? ""}
                  className="input w-full"
                  placeholder="e.g. RT001"
                />
              </div>
              <div>
                <label className="form-label" htmlFor="p-alias">Alias</label>
                <input
                  id="p-alias"
                  name="alias"
                  defaultValue={editItem?.alias ?? ""}
                  className="input w-full"
                  placeholder="Short name"
                />
              </div>
            </div>

            {/* Party type */}
            <div>
              <label className="form-label" htmlFor="p-party_type">Party Type</label>
              <select
                id="p-party_type"
                name="party_type"
                defaultValue={editItem?.party_type ?? "CUSTOMER"}
                className="input w-full"
              >
                <option value="CUSTOMER">Customer</option>
                <option value="SUPPLIER">Supplier</option>
                <option value="CF_AGENT">C&F Agent</option>
                <option value="BOTH">Both</option>
              </select>
            </div>

            {/* Multi-role checkboxes */}
            <div>
              <p className="form-label mb-2">Roles</p>
              <div className="grid grid-cols-2 gap-2 rounded-lg border border-surface-border bg-surface-subtle p-3">
                {(
                  [
                    ["is_customer", "Customer"],
                    ["is_supplier", "Supplier"],
                    ["is_cf_agent", "C&F Agent"],
                    ["is_transporter", "Transporter"],
                    ["is_wholesaler_licensed", "Wholesaler"],
                    ["is_retailer_licensed", "Retailer"],
                  ] as [keyof typeof roles, string][]
                ).map(([key, label]) => (
                  <RoleCheck
                    key={key}
                    name={key}
                    label={label}
                    checked={roles[key]}
                    onChange={(v) => setRoles((p) => ({ ...p, [key]: v }))}
                  />
                ))}
              </div>
            </div>

            {/* GST */}
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2">
                <label className="form-label" htmlFor="p-gstin">GSTIN</label>
                <input
                  id="p-gstin"
                  name="gstin"
                  defaultValue={editItem?.gstin ?? ""}
                  className="input w-full font-mono"
                  placeholder="22AAAAA0000A1Z5"
                  maxLength={15}
                />
                {fe.gstin && <p className="form-error">{fe.gstin[0]}</p>}
              </div>
              <div>
                <label className="form-label" htmlFor="p-gst_status">GST Status</label>
                <select
                  id="p-gst_status"
                  name="gst_status"
                  defaultValue={editItem?.gst_status ?? "UNREGISTERED"}
                  className="input w-full"
                >
                  {["REGULAR","COMPOSITION","UNREGISTERED","EXEMPT","SUSPENDED","CANCELLED"].map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="form-label" htmlFor="p-pan">PAN</label>
                <input
                  id="p-pan"
                  name="pan"
                  defaultValue={""}
                  className="input w-full font-mono"
                  placeholder="AAAAA0000A"
                  maxLength={10}
                />
                {fe.pan && <p className="form-error">{fe.pan[0]}</p>}
              </div>
            </div>

            {/* Contact */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="form-label" htmlFor="p-phone">Phone</label>
                <input id="p-phone" name="phone" defaultValue={editItem?.phone ?? ""} className="input w-full" placeholder="9876543210" />
              </div>
              <div>
                <label className="form-label" htmlFor="p-alt_phone">Alt Phone</label>
                <input id="p-alt_phone" name="alt_phone" defaultValue={editItem?.alt_phone ?? ""} className="input w-full" />
              </div>
              <div className="col-span-2">
                <label className="form-label" htmlFor="p-email">Email</label>
                <input id="p-email" name="email" type="email" className="input w-full" placeholder="party@email.com" />
                {fe.email && <p className="form-error">{fe.email[0]}</p>}
              </div>
            </div>

            {/* Address */}
            <div>
              <label className="form-label" htmlFor="p-address">Address</label>
              <textarea id="p-address" name="address" defaultValue={""} rows={2} className="input w-full" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="form-label" htmlFor="p-state">State</label>
                <input id="p-state" name="state" defaultValue={editItem?.state ?? ""} className="input w-full" placeholder="Maharashtra" />
              </div>
              <div>
                <label className="form-label" htmlFor="p-pincode">Pincode</label>
                <input id="p-pincode" name="pincode" className="input w-full" placeholder="400001" maxLength={6} />
              </div>
            </div>

            {/* Credit */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="form-label" htmlFor="p-credit_limit">Credit Limit (₹)</label>
                <input
                  id="p-credit_limit"
                  name="credit_limit"
                  type="number"
                  min={0}
                  step={100}
                  defaultValue={editItem?.credit_limit ?? 0}
                  className="input w-full"
                />
              </div>
              <div>
                <label className="form-label" htmlFor="p-credit_days">Credit Days</label>
                <input
                  id="p-credit_days"
                  name="credit_days"
                  type="number"
                  min={0}
                  max={365}
                  defaultValue={editItem?.credit_days ?? 0}
                  className="input w-full"
                />
              </div>
            </div>

            {/* FMS */}
            <div>
              <label className="form-label" htmlFor="p-fms_dealer_id">FMS Dealer ID</label>
              <input id="p-fms_dealer_id" name="fms_dealer_id" defaultValue={editItem?.fms_dealer_id ?? ""} className="input w-full font-mono" />
            </div>

            {/* Actions */}
            <div className="pt-2">
              <SubmitButton label={editItem ? "Update Party" : "Add Party"} />
            </div>
          </form>
        </div>
      </div>
    </>
  );
}

// ─── Main Client Component ─────────────────────────────────────
export default function PartiesClient({ initialData }: Props) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const [editItem, setEditItem] = useState<Party | null>(null);

  const openAdd = useCallback(() => {
    setEditItem(null);
    setIsOpen(true);
  }, []);

  const openEdit = useCallback((p: Party) => {
    setEditItem(p);
    setIsOpen(true);
  }, []);

  const closePanel = useCallback(() => setIsOpen(false), []);

  const handleArchive = async (id: string, name: string) => {
    if (!confirm(`Archive "${name}"? It will no longer appear in active lists.`)) return;
    const res = await archiveParty(id);
    if (res.success) {
      toast.success("Party archived");
      router.refresh();
    } else {
      toast.error(res.error ?? "Failed to archive");
    }
  };

  const filtered = initialData.filter(
    (p) =>
      p.name.toLowerCase().includes(search.toLowerCase()) ||
      (p.gstin ?? "").toLowerCase().includes(search.toLowerCase()) ||
      (p.code ?? "").toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="page-header">
        <div>
          <h1 className="page-title">Parties</h1>
          <p className="page-subtitle">Customers, suppliers, retailers, C&F agents, FPOs</p>
        </div>
        <button onClick={openAdd} className="btn btn-primary inline-flex items-center gap-2">
          <Plus className="w-4 h-4" />
          Add Party
        </button>
      </div>

      {/* Search */}
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, code or GSTIN…"
          className="w-full pl-9 pr-4 py-2 bg-white border border-surface-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-leaf-500/20 focus:border-leaf-500 placeholder:text-ink-faint shadow-sm"
          aria-label="Search parties"
        />
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Name</th>
                <th>Roles</th>
                <th>GSTIN</th>
                <th>GST Status</th>
                <th className="text-right">Credit Limit</th>
                <th>Phone</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-16 text-center">
                    <Users className="mx-auto mb-3 h-10 w-10 text-ink-faint" />
                    <p className="text-sm font-medium text-ink">
                      {search ? "No parties match your search" : "No parties yet"}
                    </p>
                    {!search && (
                      <button
                        onClick={openAdd}
                        className="mt-3 text-xs text-leaf-600 hover:underline"
                      >
                        Add your first party
                      </button>
                    )}
                  </td>
                </tr>
              ) : (
                filtered.map((p) => (
                  <tr key={p.id}>
                    <td className="font-mono text-xs text-ink-muted">{p.code ?? "—"}</td>
                    <td>
                      <div className="font-medium text-ink">{p.name}</div>
                      {p.alias && <div className="text-xs text-ink-muted">{p.alias}</div>}
                    </td>
                    <td>
                      <div className="flex flex-wrap gap-1">
                        {p.is_customer && <span className="badge badge-memo">Customer</span>}
                        {p.is_supplier && <span className="badge badge-navy">Supplier</span>}
                        {p.is_cf_agent && <span className="badge badge-gold">C&F</span>}
                        {p.is_transporter && <span className="badge badge-gray">Transport</span>}
                        {p.is_wholesaler_licensed && <span className="badge badge-green">Wholesale</span>}
                        {p.is_retailer_licensed && <span className="badge badge-green">Retail</span>}
                      </div>
                    </td>
                    <td className="font-mono text-xs">{p.gstin ?? "—"}</td>
                    <td>
                      <GstBadge status={p.gst_status} />
                    </td>
                    <td className="text-right tabular-nums text-ink-muted">
                      {formatCurrency(p.credit_limit)}
                    </td>
                    <td className="text-ink-muted">{p.phone ?? "—"}</td>
                    <td>
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => openEdit(p)}
                          className="p-1.5 rounded hover:bg-surface-subtle text-ink-muted hover:text-ink transition-colors"
                          aria-label={`Edit ${p.name}`}
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleArchive(p.id, p.name)}
                          className="p-1.5 rounded hover:bg-danger-50 text-ink-muted hover:text-danger-600 transition-colors"
                          aria-label={`Archive ${p.name}`}
                        >
                          <Archive className="w-4 h-4" />
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
            {filtered.length} of {initialData.length} parties
          </div>
        )}
      </div>

      {/* Slide-over */}
      <PartySlideOver isOpen={isOpen} editItem={editItem} onClose={closePanel} />
    </div>
  );
}
