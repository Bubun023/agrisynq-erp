-- ============================================================
-- Migration 033: Bank Module
-- Phase 10 - FertiLedger ERP
-- ============================================================

-- Bank Account Types
DO $$ BEGIN
  CREATE TYPE bank_account_type AS ENUM (
    'CURRENT', 'SAVINGS', 'CASH_CREDIT', 'OVERDRAFT', 'FIXED_DEPOSIT'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Bank Statement Entry Types
DO $$ BEGIN
  CREATE TYPE bank_txn_type AS ENUM (
    'CREDIT', 'DEBIT'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Bank Reconciliation Status
DO $$ BEGIN
  CREATE TYPE bank_recon_status AS ENUM (
    'UNMATCHED', 'MATCHED', 'MANUALLY_MATCHED', 'EXCLUDED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── Bank Accounts ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bank_accounts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  organisation_id  uuid NOT NULL REFERENCES organisations(id),
  branch_id        uuid REFERENCES branches(id),
  account_name     text NOT NULL,
  account_no       text NOT NULL,
  bank_name        text NOT NULL,
  branch_name      text,
  ifsc_code        text,
  account_type     bank_account_type NOT NULL DEFAULT 'CURRENT',
  currency         text NOT NULL DEFAULT 'INR',
  opening_balance  numeric(18,2) NOT NULL DEFAULT 0,
  opening_date     date NOT NULL DEFAULT CURRENT_DATE,
  is_active        boolean NOT NULL DEFAULT true,
  gl_account_id    uuid REFERENCES chart_of_accounts(id),
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, account_no)
);

DROP TRIGGER IF EXISTS trg_bank_accounts_updated_at ON bank_accounts;
CREATE TRIGGER trg_bank_accounts_updated_at
  BEFORE UPDATE ON bank_accounts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE bank_accounts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation_bank_accounts" ON bank_accounts
  FOR ALL USING (tenant_id = public.get_tenant_id())
  WITH CHECK (tenant_id = public.get_tenant_id());

CREATE INDEX IF NOT EXISTS idx_bank_accounts_org ON bank_accounts(organisation_id);

-- ─── Bank Statement Lines ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS bank_statement_lines (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  organisation_id  uuid NOT NULL REFERENCES organisations(id),
  bank_account_id  uuid NOT NULL REFERENCES bank_accounts(id) ON DELETE CASCADE,
  import_batch_id  uuid,                     -- groups lines from same upload
  value_date       date NOT NULL,
  txn_date         date,
  description      text NOT NULL,
  ref_no           text,
  cheque_no        text,
  txn_type         bank_txn_type NOT NULL,
  amount           numeric(18,2) NOT NULL,
  balance          numeric(18,2),
  recon_status     bank_recon_status NOT NULL DEFAULT 'UNMATCHED',
  matched_jv_id    uuid REFERENCES journal_vouchers(id),
  matched_receipt_id uuid REFERENCES payment_receipts(id),
  matched_at       timestamptz,
  matched_by       uuid REFERENCES auth.users(id),
  notes            text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_bank_stmt_updated_at ON bank_statement_lines;
CREATE TRIGGER trg_bank_stmt_updated_at
  BEFORE UPDATE ON bank_statement_lines
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE bank_statement_lines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "org_isolation_bank_stmt" ON bank_statement_lines
  FOR ALL USING (tenant_id = public.get_tenant_id())
  WITH CHECK (tenant_id = public.get_tenant_id());

CREATE INDEX IF NOT EXISTS idx_bank_stmt_org     ON bank_statement_lines(organisation_id);
CREATE INDEX IF NOT EXISTS idx_bank_stmt_account ON bank_statement_lines(bank_account_id);
CREATE INDEX IF NOT EXISTS idx_bank_stmt_date    ON bank_statement_lines(value_date DESC);
CREATE INDEX IF NOT EXISTS idx_bank_stmt_status  ON bank_statement_lines(recon_status);

-- ─── View: vw_bank_account_balance ───────────────────────────
CREATE OR REPLACE VIEW vw_bank_account_balance WITH (security_invoker = true) AS
SELECT
  ba.id               AS bank_account_id,
  ba.tenant_id,
  ba.organisation_id,
  ba.account_name,
  ba.account_no,
  ba.bank_name,
  ba.branch_name,
  ba.ifsc_code,
  ba.account_type,
  ba.currency,
  ba.opening_balance,
  ba.opening_date,
  ba.is_active,
  COALESCE(SUM(CASE WHEN sl.txn_type = 'CREDIT' THEN sl.amount ELSE -sl.amount END), 0)
    + ba.opening_balance                     AS current_balance,
  COUNT(sl.id)                               AS total_stmt_lines,
  COUNT(sl.id) FILTER (WHERE sl.recon_status = 'UNMATCHED') AS unmatched_count,
  MAX(sl.value_date)                         AS last_stmt_date
FROM bank_accounts ba
LEFT JOIN bank_statement_lines sl ON sl.bank_account_id = ba.id
GROUP BY
  ba.id, ba.tenant_id, ba.organisation_id, ba.account_name, ba.account_no,
  ba.bank_name, ba.branch_name, ba.ifsc_code, ba.account_type,
  ba.currency, ba.opening_balance, ba.opening_date, ba.is_active;

-- ─── View: vw_bank_reconciliation ────────────────────────────
-- Unmatched statement lines ready for matching
CREATE OR REPLACE VIEW vw_bank_reconciliation WITH (security_invoker = true) AS
SELECT
  sl.*,
  ba.account_name,
  ba.bank_name,
  ba.account_no
FROM bank_statement_lines sl
JOIN bank_accounts ba ON ba.id = sl.bank_account_id
WHERE sl.recon_status IN ('UNMATCHED', 'MANUALLY_MATCHED');

GRANT SELECT ON vw_bank_account_balance  TO authenticated;
GRANT SELECT ON vw_bank_reconciliation   TO authenticated;
GRANT SELECT, INSERT, UPDATE ON bank_accounts         TO authenticated;
GRANT SELECT, INSERT, UPDATE ON bank_statement_lines  TO authenticated;
