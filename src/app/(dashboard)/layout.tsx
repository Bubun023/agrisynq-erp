import type { Metadata } from "next";
import { createClient } from "@/lib/supabase/server";
import { redirect } from "next/navigation";
import Sidebar from "@/components/layout/Sidebar";
import Topbar from "@/components/layout/Topbar";
import { getUserContext } from "@/actions/context";
import { signOutAction } from "@/actions/auth";

export const metadata: Metadata = {
  title: { template: "%s — FertiLedger ERP", default: "FertiLedger ERP" },
  description:
    "Agricultural Trade, Inventory, Accounts & Compliance ERP — Stock. Accounts. Compliance. Connected.",
};

/**
 * Dashboard shell layout — rendered on every authenticated page.
 * Server component: validates session before rendering.
 * Unauthenticated users are redirected to /login by middleware,
 * but we double-check here for defence in depth.
 */
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // Block unprovisioned accounts (no role/organisation) instead of showing
  // empty pages that look like "no data".
  const ctx = await getUserContext();
  if (!ctx.provisioned) {
    return (
      <div className="min-h-screen bg-surface-bg flex items-center justify-center p-6">
        <div className="card p-8 max-w-md text-center space-y-3">
          <h1 className="text-lg font-semibold text-ink">Account not set up yet</h1>
          <p className="text-sm text-ink-muted">
            You are signed in as {user.email}, but your account has not been assigned to an
            organisation or role. Ask your administrator to add you, then sign in again.
          </p>
          <form action={signOutAction}>
            <button type="submit" className="btn btn-primary">Sign out</button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-surface-bg">
      {/* Fixed sidebar */}
      <Sidebar />

      {/* Fixed topbar — positioned to the right of sidebar */}
      <Topbar />

      {/* Main content area */}
      <main
        className="flex-1"
        style={{
          marginLeft: "var(--sidebar-width)",
          marginTop: "var(--topbar-height)",
          minHeight: "calc(100vh - var(--topbar-height))",
          padding: "1.5rem",
        }}
      >
        {children}
      </main>
    </div>
  );
}
