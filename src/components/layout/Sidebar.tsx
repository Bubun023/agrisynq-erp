"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { LayoutDashboard, Users, Package, Warehouse, FileCheck, ShoppingCart, Truck, ReceiptText, FileText, ArrowLeftRight, ClipboardList, BookOpen, CreditCard, Building2, PiggyBank, BarChart3, ScrollText, RefreshCcw, Settings, Shield, FileSearch, ChevronDown, ChevronRight, Sprout, Boxes, FilePlus2, Banknote, Calculator, AlertCircle, Upload } from "lucide-react";
import { useState } from "react";

// ─── Nav structure ─────────────────────────────────────────────────────────
type NavItem = {
  label: string;
  href: string;
  icon: React.ElementType;
  badge?: string;
};

type NavGroup = {
  label: string;
  items: NavItem[];
};

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Overview",
    items: [
      { label: "Dashboard",        href: "/",                     icon: LayoutDashboard },
    ],
  },
  {
    label: "Master Data",
    items: [
      { label: "Parties",          href: "/master-data/parties",   icon: Users },
      { label: "Farmers",          href: "/master-data/farmers",   icon: Sprout },
      { label: "Products",         href: "/master-data/products",  icon: Package },
      { label: "Locations",        href: "/master-data/locations", icon: Warehouse },
      { label: "Licences",         href: "/master-data/licences",  icon: FileCheck },
    ],
  },
  {
    label: "Purchases",
    items: [
      { label: "Purchase Orders",  href: "/purchases/orders",      icon: ShoppingCart },
      { label: "Goods Receipts",   href: "/purchases/grn",         icon: Truck },
      { label: "Purchase Invoices",href: "/purchases/invoices",    icon: ReceiptText },
      { label: "Memo Purchases",   href: "/purchases/memo",        icon: FilePlus2 },
    ],
  },
  {
    label: "C&F Management",
    items: [
      { label: "C&F Stock",        href: "/cf-management/stock",         icon: Boxes },
      { label: "Withdrawals",      href: "/cf-management/withdrawals",   icon: ArrowLeftRight },
      { label: "Gate Passes",      href: "/cf-management/gate-passes",   icon: FileText },
    ],
  },
  {
    label: "Sales",
    items: [
      { label: "Quotations / Pro Forma", href: "/sales/quotations",       icon: ClipboardList },
      { label: "Sales Orders",           href: "/sales/orders",           icon: ShoppingCart },
      { label: "Tax Invoices",           href: "/sales/invoices",         icon: ReceiptText },
      { label: "Memo Sales",             href: "/sales/memo",             icon: FilePlus2 },
      { label: "Delivery Challans",      href: "/sales/delivery-challans",icon: Truck },
      { label: "Credit / Debit Notes",   href: "/sales/credit-notes",     icon: FileText },
    ],
  },
  {
    label: "Logistics",
    items: [
      { label: "Transporters",       href: "/logistics/transporters",  icon: Truck },
      { label: "Stock Transfers",    href: "/logistics/transfers",     icon: ArrowLeftRight },
      { label: "Delivery Challans",  href: "/logistics/challans",      icon: FileText },
    ],
  },
  {
    label: "Inventory",
    items: [
      { label: "Stock Ledger",       href: "/inventory/ledger",       icon: BookOpen },
      { label: "Batch Register",     href: "/inventory/batches",      icon: Package },
      { label: "Transfers",          href: "/inventory/transfers",    icon: ArrowLeftRight },
      { label: "Adjustments",        href: "/inventory/adjustments",  icon: AlertCircle },
      { label: "Stock Journal",      href: "/inventory/journals",     icon: ArrowLeftRight },
    ],
  },
  {
    label: "Accounting",
    items: [
      { label: "Chart of Accounts",  href: "/accounting/accounts",    icon: BookOpen },
      { label: "Vouchers",           href: "/accounting/vouchers",    icon: ScrollText },
      { label: "Receipts",           href: "/accounting/receipts",    icon: CreditCard },
      { label: "Settlements",        href: "/accounting/settlements", icon: Banknote },
      { label: "AR — Receivables",   href: "/accounting/ar",          icon: Building2 },
      { label: "AP — Payables",      href: "/accounting/ap",          icon: PiggyBank },
      { label: "Trial Balance",      href: "/accounting/trial-balance",icon: Calculator },
    ],
  },
  {
    label: "GST",
    items: [
      { label: "Sales Register",    href: "/gst/sales-register",    icon: ReceiptText },
      { label: "Purchase Register", href: "/gst/purchase-register", icon: ShoppingCart },
      { label: "GSTR-1",            href: "/gst/gstr1",             icon: FileText },
      { label: "GSTR-3B",           href: "/gst/gstr3b",            icon: FileText },
      { label: "GSTR-2B Recon",     href: "/gst/gstr2b",            icon: RefreshCcw },
    ],
  },
  {
    label: "FMS Compliance",
    items: [
      { label: "FMS Ledger",        href: "/fms/ledger",            icon: ScrollText },
      { label: "Import FMS Data",   href: "/fms/import",            icon: FilePlus2 },
      { label: "Reconciliation",    href: "/fms/reconciliation",    icon: RefreshCcw },
      { label: "Cancel & Reissue",  href: "/fms/reissue",           icon: AlertCircle },
      { label: "Subsidy Claims",    href: "/fms/subsidy",           icon: Banknote },
    ],
  },
  {
    label: "Bank",
    items: [
      { label: "Bank Accounts",     href: "/bank/accounts",         icon: Building2 },
      { label: "Statements",        href: "/bank/statements",       icon: FileSearch },
      { label: "Reconciliation",    href: "/bank/reconciliation",   icon: RefreshCcw },
    ],
  },
  {
    label: "Reports",
    items: [
      { label: "All Reports",       href: "/reports",               icon: BarChart3 },
    ],
  },
  {
    label: "Administration",
    items: [
      { label: "Users & Roles",     href: "/admin/users",           icon: Shield },
      { label: "Audit Log",         href: "/admin/audit",           icon: FileSearch },
      { label: "Period Locks",      href: "/admin/periods",         icon: FileCheck },
      { label: "Tax Profiles",      href: "/admin/tax-profiles",    icon: Calculator },
      { label: "Units of Measure",  href: "/admin/uom",             icon: Package },
      { label: "Data Import",       href: "/admin/import",          icon: Upload },
      { label: "Settings",          href: "/admin/settings",        icon: Settings },
    ],
  },
];

// ─── Collapsible group ─────────────────────────────────────────────────────
function NavGroup({
  group,
  pathname,
}: {
  group: NavGroup;
  pathname: string;
}) {
  const isActive = group.items.some(
    (i) => pathname === i.href || pathname.startsWith(i.href + "/")
  );
  const [open, setOpen] = useState(isActive || group.label === "Overview");

  return (
    <div>
      {group.label !== "Overview" && (
        <button
          onClick={() => setOpen((v) => !v)}
          className="w-full flex items-center justify-between px-3 mt-4 mb-0.5 group"
          aria-expanded={open}
        >
          <span className="nav-group-label !mt-0 !mb-0">
            {group.label}
          </span>
          {open ? (
            <ChevronDown className="w-3 h-3 text-navy-500 group-hover:text-navy-300 transition-colors" />
          ) : (
            <ChevronRight className="w-3 h-3 text-navy-500 group-hover:text-navy-300 transition-colors" />
          )}
        </button>
      )}

      {open && (
        <div className="space-y-0.5">
          {group.items.map((item) => {
            const active =
              pathname === item.href ||
              (item.href !== "/" && pathname.startsWith(item.href + "/"));
            const Icon = item.icon;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn("nav-item", active && "nav-item-active")}
              >
                <Icon className="w-4 h-4 shrink-0" strokeWidth={1.75} />
                <span className="truncate">{item.label}</span>
                {item.badge && (
                  <span className="ml-auto text-2xs bg-gold-500/20 text-gold-300 px-1.5 py-0.5 rounded-full font-medium">
                    {item.badge}
                  </span>
                )}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Sidebar ───────────────────────────────────────────────────────────────
export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside
      id="sidebar"
      className={cn(
        "fixed inset-y-0 left-0 z-40 flex flex-col",
        "w-[var(--sidebar-width)] bg-navy-950 border-r border-navy-800",
        "animate-slide-in-left"
      )}
    >
      {/* Logo / Header block */}
      <Link
        href="/"
        className="flex items-center justify-center gap-2.5 h-[var(--topbar-height,64px)] px-4 bg-navy-900 border-b border-navy-800 shrink-0 hover:bg-navy-800 transition-colors"
      >
        {/* FertiLedger brand mark + wordmark */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/logo-mark.svg"
          alt="FertiLedger ERP"
          className="h-9 w-9 shrink-0 select-none"
        />
        <span className="flex items-baseline gap-1.5 select-none">
          <span
            className="text-xl font-bold tracking-wide text-[#F7F0DC]"
            style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
          >
            FertiLedger
          </span>
          <span className="text-[10px] font-semibold tracking-[0.2em] text-[#E2BC62]">
            ERP
          </span>
        </span>
      </Link>

      {/* Navigation */}
      <nav
        className="flex-1 overflow-y-auto px-3 py-3 space-y-0.5"
        aria-label="Main navigation"
      >
        {NAV_GROUPS.map((group) => (
          <NavGroup key={group.label} group={group} pathname={pathname} />
        ))}
      </nav>

      {/* Bottom strip */}
      <div className="px-3 py-3 border-t border-navy-800 shrink-0">
        <div className="flex items-center gap-2 px-3 py-2">
          <div className="w-7 h-7 rounded-full bg-leaf-600/20 flex items-center justify-center text-xs font-semibold text-leaf-400 shrink-0">
            A
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-xs font-medium text-white truncate">Admin</div>
            <div className="text-2xs text-navy-400 truncate">Super Admin</div>
          </div>
        </div>
      </div>
    </aside>
  );
}