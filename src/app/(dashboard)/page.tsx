import type { Metadata } from "next";
import { getDashboardStats } from "@/actions/dashboard";
import {
  Package, ReceiptText, AlertCircle,
  TrendingUp, Boxes, RefreshCcw,
  ArrowUpRight, Clock, Banknote,
} from "lucide-react";
import { formatCurrency } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Dashboard — FertiLedger ERP",
};

// ─── Stat Card ──────────────────────────────────────────────────────────────
function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  accent = "leaf",
  alert = false,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: React.ElementType;
  accent?: "leaf" | "gold" | "navy" | "danger";
  alert?: boolean;
}) {
  const accentMap = {
    leaf:   "bg-leaf-50 text-leaf-600",
    gold:   "bg-gold-50 text-gold-600",
    navy:   "bg-navy-50 text-navy-700",
    danger: "bg-danger-50 text-danger-600",
  };

  return (
    <div className="stat-card flex items-start gap-4">
      <div className={`p-2.5 rounded-lg ${accentMap[accent]} shrink-0`}>
        <Icon className="w-5 h-5" strokeWidth={1.75} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="stat-label">{label}</p>
        <p className={`stat-value ${alert ? "text-danger-600" : ""}`}>{value}</p>
        {sub && <p className="stat-sub">{sub}</p>}
      </div>
      {alert && (
        <AlertCircle className="w-4 h-4 text-danger-500 shrink-0 mt-1" />
      )}
    </div>
  );
}

// ─── Section header ─────────────────────────────────────────────────────────
function SectionHeader({ title, action }: { title: string; action?: string }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      {action && (
        <a
          href={action}
          className="text-xs text-leaf-600 hover:text-leaf-700 flex items-center gap-1"
        >
          View all <ArrowUpRight className="w-3 h-3" />
        </a>
      )}
    </div>
  );
}

// ─── Dashboard Page ──────────────────────────────────────────────────────────
export const dynamic = "force-dynamic";

const num = (n: number) => new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(n);

export default async function DashboardPage() {
  const s = await getDashboardStats();

  return (
    <div className="max-w-7xl mx-auto">
      <div className="page-header">
        <div>
          <h1 className="page-title">Dashboard</h1>
          <p className="page-subtitle">
            FertiLedger ERP — Stock. Accounts. Compliance. Connected.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-ink-muted">
          <Clock className="w-3.5 h-3.5" />
          <span>Live data · {s.currentPeriod}</span>
        </div>
      </div>

      {s.failed.length > 0 && (
        <div className="mb-4 border border-gold-200 bg-gold-50 rounded-lg px-4 py-3 text-sm text-gold-800 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>
            Some figures could not be loaded ({s.failed.join(", ")}) and are shown as 0.
            If this persists, check that all database migrations have been applied.
          </span>
        </div>
      )}

      {/* ── Top KPI row ── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard
          label="Today's Sales"
          value={formatCurrency(s.todaySales)}
          sub={`${formatCurrency(s.salesThisMonth)} this month`}
          icon={ReceiptText}
          accent="leaf"
        />
        <StatCard
          label="Overdue Receivables"
          value={formatCurrency(s.overdueAR)}
          sub={`${s.overdueARCount} invoice(s) past due date`}
          icon={TrendingUp}
          accent="danger"
          alert={s.overdueAR > 0}
        />
        <StatCard
          label="Payables Overdue"
          value={formatCurrency(s.payablesDue)}
          sub="Supplier invoices past due date"
          icon={Banknote}
          accent="gold"
          alert={s.payablesDue > 0}
        />
        <StatCard
          label="Draft Invoices"
          value={String(s.draftInvoices)}
          sub="Sales invoices waiting to be posted"
          icon={Boxes}
          accent={s.draftInvoices > 0 ? "gold" : "navy"}
        />
      </div>

      {/* ── Stock row ── */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 mb-6">
        <StatCard
          label="Stock On Hand"
          value={`${num(s.stockOnHandUnits)} units`}
          sub="Across all locations (stock ledger)"
          icon={Package}
          accent="navy"
        />
        <StatCard
          label="Stock Value"
          value={formatCurrency(s.stockValue)}
          sub="Stock-in-Hand account at batch cost"
          icon={Boxes}
          accent="leaf"
        />
        <StatCard
          label="Expiring Batches (60 days)"
          value={String(s.expiringBatches)}
          sub={s.expiredWithStock > 0 ? `${s.expiredWithStock} already expired with stock` : "With stock on hand"}
          icon={AlertCircle}
          accent={s.expiringBatches > 0 || s.expiredWithStock > 0 ? "gold" : "navy"}
          alert={s.expiredWithStock > 0}
        />
        <StatCard
          label="Transfers In Transit"
          value={String(s.transfersInTransit)}
          sub="Dispatched, awaiting receipt"
          icon={RefreshCcw}
          accent="navy"
        />
      </div>

      {/* ── Two column: Quick links + Compliance status ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* Quick Actions */}
        <div className="card p-5">
          <SectionHeader title="Quick Actions" />
          <div className="grid grid-cols-2 gap-2">
            {[
              { label: "Sales Invoices",      href: "/sales/invoices" },
              { label: "Purchase Invoices",   href: "/purchases/invoices" },
              { label: "Payment Receipts",    href: "/accounting/receipts" },
              { label: "Purchase Orders",     href: "/purchases/orders" },
              { label: "Stock Ledger",        href: "/inventory/ledger" },
              { label: "Reports",             href: "/reports" },
            ].map((a) => (
              <a
                key={a.href}
                href={a.href}
                className="flex items-center gap-2 px-3 py-2.5 rounded-md border border-surface-border text-sm text-ink hover:bg-surface-subtle hover:border-leaf-200 transition-colors"
              >
                <ArrowUpRight className="w-3.5 h-3.5 text-ink-faint shrink-0" />
                {a.label}
              </a>
            ))}
          </div>
        </div>

        {/* Compliance Status */}
        <div className="card p-5">
          <SectionHeader title="Compliance Status" />
          <div className="space-y-3">
            {[
              {
                label: "Accounting Period",
                status: s.currentPeriodLocked ? "Locked" : "Open",
                color: s.currentPeriodLocked ? "badge-gold" : "badge-green",
                detail: `${s.currentPeriod}${s.currentPeriodLocked ? " is locked — no new postings" : ""}`,
                href: "/admin/periods",
              },
              {
                label: "FMS Reconciliation",
                status: s.fmsPending > 0 ? `${s.fmsPending} Pending` : "Clear",
                color: s.fmsPending > 0 ? "badge-gold" : "badge-green",
                detail: s.fmsPending > 0 ? "Reconciliations with variance or awaiting review" : "No unresolved reconciliations",
                href: "/fms/reconciliation",
              },
              {
                label: "Licences",
                status: `${s.activeLicences} Active`,
                color: s.licencesExpiring30 > 0 ? "badge-gold" : "badge-green",
                detail: s.licencesExpiring30 > 0
                  ? `${s.licencesExpiring30} expiring within 30 days`
                  : "None expiring within 30 days",
                href: "/master-data/licences",
              },
              {
                label: "Bank Reconciliation",
                status: s.unmatchedBankLines > 0 ? `${s.unmatchedBankLines} Unmatched` : "Up to date",
                color: s.unmatchedBankLines > 0 ? "badge-gold" : "badge-green",
                detail: s.unmatchedBankLines > 0 ? "Statement lines not yet matched to books" : "No unmatched statement lines",
                href: "/bank/reconciliation",
              },
            ].map((item) => (
              <a
                key={item.label}
                href={item.href}
                className="flex items-start justify-between gap-4 py-2 border-b border-surface-border last:border-b-0 hover:bg-surface-subtle -mx-2 px-2 rounded"
              >
                <div>
                  <div className="text-sm font-medium text-ink">{item.label}</div>
                  <div className="text-xs text-ink-muted mt-0.5">{item.detail}</div>
                </div>
                <span className={`badge ${item.color} shrink-0`}>{item.status}</span>
              </a>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
