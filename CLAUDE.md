# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

FertiLedger ERP (package `fertiledger-erp`, repo name `agrisynq-erp`): an Indian agri-inputs trading ERP (fertilisers, pesticides, seeds) covering master data, purchases, sales, inventory/batches, logistics, accounting, GST, bank reconciliation, reports and admin. Domain concepts that recur everywhere: batch/expiry tracking, licences, farmer sales for the FMS/iFMS government portal, C&F (carrying & forwarding) stock, memo (unbilled) purchases/sales, GSTIN/HSN/CGST-SGST-IGST.

Stack: Next.js 14 App Router, React 18, TypeScript, Tailwind, Supabase (Postgres + Auth + RLS) via `@supabase/ssr`, zod, sonner, lucide-react, Vitest.

## Commands

```
npm run dev            # next dev
npm run build
npm run lint           # next lint
npm run type-check     # tsc --noEmit
npm test               # vitest run (all)
npx vitest run src/lib/__tests__/phase1.test.ts          # single file
npx vitest run -t "test name pattern"                    # single test
bash supabase/tests/run_db_tests.sh                       # DB: applies ALL migrations to a throwaway Docker Postgres + runs the SQL e2e tests
```

`run_db_tests.sh` uses a Supabase stub (`supabase_stub.sql`) and a disposable `fl-pg` container; it never touches a real project. Run it after ANY change to `supabase/migrations/*` or to posting logic - migrations 031-034 were once committed that could not even apply, and nothing caught it. Add new scenarios as `supabase/tests/e2e_*.sql` (see `e2e_posting.sql` for the pattern: act as a user via `SET ROLE authenticated` + `request.jwt.claim.sub`).

Env (`.env.local`): `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SECRET_KEY`, etc. The dashboard home page checks these to decide whether Supabase is "configured".

The `run-phaseN-push.bat/.ps1` scripts at the root are the previous author's release ritual: `tsc --noEmit` → `vitest run` → `git add -A` → commit → `git push upstream main`. Commit messages follow `feat(phaseN): … TS:CLEAN Vitest:PASS`. Note they `git add -A` and push to the `upstream` remote (`caprivaa14/agrisynq-erp`), not `origin`; don't run them blindly.

## Architecture

**Request flow:** `src/middleware.ts` → `lib/supabase/middleware.ts#updateSession` refreshes the session and enforces auth. `app/(auth)/login` is public; everything under `app/(dashboard)` is wrapped by a layout (Sidebar + Topbar) that re-checks `supabase.auth.getUser()`. Path alias `@/*` → `src/*`.

**Page pattern (follow it for new modules):** `app/(dashboard)/<module>/<feature>/page.tsx` is a thin server component that calls server actions to fetch initial data, then renders a `*Client.tsx` component (forms, tables, filters, `sonner` toasts) with that data as props. Business logic lives in server actions, not in client components.

**Server actions (`src/actions/*.ts`, `"use server"`)** are the entire backend API — there are no route handlers. Conventions:
- Every action starts with `getUserContext()` (`actions/context.ts`), which resolves `tenantId / organisationId / branchId / roleName` from `user_roles` for the session user. Never accept tenant/org IDs from the browser; scope every query with them.
- `getUserContext` has a deliberate fallback: if the user has no `user_roles` row (migrations not applied / unprovisioned user) it returns the auth user id as placeholder tenant/org so pages render empty rather than loop. Be aware this masks missing-role problems.
- Input is validated with zod schemas defined at the top of each action file; mutations call `writeAuditLog()` (best-effort, never throws) and `revalidatePath()`.
- Document numbers come from Postgres RPCs (`generate_po_number`, `generate_invoice_number`, `generate_pi_number`, `generate_so_number`, `generate_sq_number`, `generate_cn_number`, `generate_fs_number`); stock via `get_stock_balance`, `get_expiring_batches`. Reports/GST/bank/admin read from SQL views (`vw_*`) built in the later migrations.
- **Posting is done in the database, atomically** (migration 038): `post_sales_invoice`, `post_purchase_invoice`, `post_credit_note` (`SECURITY DEFINER`, tenant from session) validate stock/batches, write `stock_ledger`, create a balanced journal voucher (perpetual inventory: purchase DR Stock/ITC CR Creditors; sale DR Debtors CR Sales/GST + DR COGS CR Stock at batch cost) and flip the status in one transaction. Receipts post via `rpc_post_payment_receipt` (037), adjustments via `post_stock_adjustment` (032). Server actions just call these RPCs; do NOT reimplement posting in TypeScript, and do not insert POSTED rows directly.
- **Status lock-down (039):** RLS lets users create/edit only DRAFT documents; nothing but the posting functions can set POSTED. Posted documents/vouchers are immutable to users. The system chart of accounts (codes 1001,1010,1020,2001,2010-12,3001-03,3020,4001-03,4040-42) must be seeded or posting raises a clear error.
- `batch_register.current_qty` is maintained by a trigger on `stock_ledger` (038) - never update it from code. Views over RLS tables use `security_invoker`.
- Invoice/GST arithmetic lives in `src/lib/gst.ts` (`computeLine`, `sumLines`, `splitGst`, `resolveInvoiceType`) and is shared by sales invoices, purchase invoices and credit notes. Rule: round each line to 2dp, document totals = sum of rounded lines, CGST+SGST always equals total GST. Don't re-implement GST math inside actions; it has real unit tests in `src/lib/__tests__/gst.test.ts`.

**Database (`supabase/migrations/001…035`)** is the source of truth for the schema and is applied manually/in order (no Supabase CLI config in the repo). `_v2` migrations (011–016) rework the earlier master-data tables; `009_rls_fix` patches RLS. Multi-tenancy is `tenant → organisation → branch/location`, enforced by RLS plus explicit filters in actions. Posting a purchase invoice is meant to create batches, stock-ledger movements and an AP entry (the GRN page is intentionally just an explainer for this). `src/lib/types.ts` holds shared hand-written types (no generated Supabase types).

**Navigation:** the sidebar (`components/layout/Sidebar.tsx`) hard-codes `NAV_GROUPS`; new pages must be added there manually.

## Project status / gotchas

- All 12 phases are committed locally. Migrations 031-034 (GST/inventory/bank/reports) were rewritten in Nov 2026 because the originals never applied (made-up tables/columns); 035-039 added admin, integrity hardening, accounting fixes, the posting engine and the status lock-down. Roles are the uppercase system roles from migration 005 (`SUPER_ADMIN`, `BRANCH_ADMIN`, `ACCOUNTANT`, `SALES_MANAGER`, `STOCK_MANAGER`, `FMS_COMPLIANCE`, `VIEWER`); admin-only actions check `SUPER_ADMIN`/`BRANCH_ADMIN`. Period locks live in `period_locks` (010) and are enforced by DB triggers (036).
- Known gaps: invitations are only recorded (no email, no accept flow); stock_ledger can still be inserted directly by any tenant user (opening stock etc.), only posting documents are locked down; credit-note/receipt screens lack allocation UI (receipts auto-allocate oldest-first on Post); inventory screens still contain orphan duplicates (`inventory/adjustments/AdjustmentsClient`, `inventory/batches/BatchesClient`, `inventory/transfers/TransferClient`) that no page imports.
- `getUserContext()` returns `provisioned: false` for users without a role; the dashboard layout shows a blocking "Account not set up" screen.
- `npm run lint` reports ~26 pre-existing errors (unused imports, a few `any`); the build doesn't fail on them (lint is skipped during build).
- Placeholder "Coming in Phase N" pages (UI stubs, no actions/tables wired): `cf-management/{stock,withdrawals,gate-passes}`, `fms/{ledger,import,reconciliation,reissue}`, `accounting/settlements`, `purchases/memo`, `sales/delivery-challans`. Schema for some (FMS, gate passes, challans: migrations 025/026/028) exists; the sidebar's "Delivery Challans" under Logistics (`logistics/challans`) is the implemented one.
- Dashboard home (`app/(dashboard)/page.tsx`) shows hard-coded zero stats (TODO in code).
- Tests are minimal: `gst.test.ts` tests the real GST module, but `phase1.test.ts` only tests *inline copies* of util functions, and the vitest env is `node`. Actions, RLS and UI are effectively untested; "TS:CLEAN Vitest:PASS" in commit messages says little about correctness.
- Some inventory/logistics screens have duplicate client components (e.g. `BatchesClient` vs `BatchRegisterClient`, `AdjustmentsClient` vs `StockAdjustmentsClient`, `TransferClient` vs `StockTransfersClient`, and `inventory/transfers` vs `logistics/transfers`) and still ask for raw UUIDs in places; check which one the `page.tsx` actually imports before editing.
- `.env.local` defines a `NEXTAUTH_SECRET`, but NextAuth is not used (auth is Supabase).
