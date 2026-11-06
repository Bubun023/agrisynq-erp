-- ============================================================
-- Migration 034: Reports Views
-- Phase 11 - FertiLedger ERP
-- ============================================================
-- All views are security_invoker: the caller's RLS on the base tables applies.
-- Built on the real schema (029 accounting, 022/024 invoices, 030 receipts).

-- ─── P&L Summary ─────────────────────────────────────────────
-- Income vs Expense per month from POSTED journal vouchers.
CREATE OR REPLACE VIEW vw_pl_summary WITH (security_invoker = true) AS
WITH jv_lines AS (
  SELECT
    jv.tenant_id,
    jv.organisation_id,
    coa.account_type::text AS account_type,
    coa.account_name,
    coa.account_code,
    DATE_PART('year',  jv.voucher_date)::int AS fyear,
    DATE_PART('month', jv.voucher_date)::int AS fmonth,
    jvl.debit_amount,
    jvl.credit_amount
  FROM journal_voucher_lines jvl
  JOIN journal_vouchers jv   ON jv.id  = jvl.voucher_id
  JOIN chart_of_accounts coa ON coa.id = jvl.account_id
  WHERE jv.status = 'POSTED'
)
SELECT
  tenant_id, organisation_id, fyear, fmonth, account_type, account_code, account_name,
  SUM(CASE
    WHEN account_type = 'INCOME'  THEN credit_amount - debit_amount
    WHEN account_type = 'EXPENSE' THEN debit_amount  - credit_amount
    ELSE 0
  END) AS net_amount
FROM jv_lines
WHERE account_type IN ('INCOME', 'EXPENSE')
GROUP BY tenant_id, organisation_id, fyear, fmonth, account_type, account_code, account_name;

-- ─── Trial Balance (with opening balances) ───────────────────
CREATE OR REPLACE VIEW vw_trial_balance_full WITH (security_invoker = true) AS
WITH jv_totals AS (
  SELECT
    jvl.account_id,
    SUM(jvl.debit_amount)  AS total_debit,
    SUM(jvl.credit_amount) AS total_credit
  FROM journal_voucher_lines jvl
  JOIN journal_vouchers jv ON jv.id = jvl.voucher_id
  WHERE jv.status = 'POSTED'
  GROUP BY jvl.account_id
)
SELECT
  coa.tenant_id,
  coa.organisation_id,
  coa.id                 AS account_id,
  coa.account_code,
  coa.account_name,
  coa.account_type::text AS account_type,
  coa.parent_account_id  AS parent_id,
  -- Opening balance signed as debit(+) / credit(-)
  CASE WHEN coa.opening_balance_type::text = 'CR' THEN -COALESCE(coa.opening_balance, 0)
       ELSE COALESCE(coa.opening_balance, 0) END                       AS opening_balance,
  COALESCE(jt.total_debit,  0)                                         AS total_debit,
  COALESCE(jt.total_credit, 0)                                         AS total_credit,
  CASE WHEN coa.opening_balance_type::text = 'CR' THEN -COALESCE(coa.opening_balance, 0)
       ELSE COALESCE(coa.opening_balance, 0) END
    + COALESCE(jt.total_debit, 0) - COALESCE(jt.total_credit, 0)       AS net_balance
FROM chart_of_accounts coa
LEFT JOIN jv_totals jt ON jt.account_id = coa.id
WHERE coa.is_active = true;

-- ─── Ageing: Receivables ─────────────────────────────────────
CREATE OR REPLACE VIEW vw_ageing_receivables WITH (security_invoker = true) AS
SELECT
  si.tenant_id,
  si.organisation_id,
  si.customer_id                                    AS party_id,
  COALESCE(p.name, si.customer_name, 'Walk-in')     AS party_name,
  COALESCE(p.gstin, si.customer_gstin)              AS gstin,
  si.invoice_number                                 AS invoice_no,
  si.invoice_date,
  si.due_date,
  si.net_receivable                                 AS total_amount,
  si.amount_received                                AS amount_paid,
  si.outstanding_amount                             AS outstanding,
  CURRENT_DATE - COALESCE(si.due_date, si.invoice_date) AS days_overdue,
  CASE
    WHEN CURRENT_DATE <= COALESCE(si.due_date, si.invoice_date)      THEN 'NOT_DUE'
    WHEN CURRENT_DATE - COALESCE(si.due_date, si.invoice_date) <= 30 THEN '1_30'
    WHEN CURRENT_DATE - COALESCE(si.due_date, si.invoice_date) <= 60 THEN '31_60'
    WHEN CURRENT_DATE - COALESCE(si.due_date, si.invoice_date) <= 90 THEN '61_90'
    ELSE 'OVER_90'
  END AS ageing_bucket
FROM sales_invoices si
LEFT JOIN parties p ON p.id = si.customer_id
WHERE si.status = 'POSTED'
  AND si.outstanding_amount > 0;

-- ─── Ageing: Payables ────────────────────────────────────────
CREATE OR REPLACE VIEW vw_ageing_payables WITH (security_invoker = true) AS
SELECT
  pi.tenant_id,
  pi.organisation_id,
  pi.supplier_id                                    AS party_id,
  p.name                                            AS party_name,
  COALESCE(p.gstin, pi.supplier_gstin)              AS gstin,
  pi.invoice_number                                 AS invoice_no,
  pi.invoice_date,
  pi.due_date,
  pi.net_payable                                    AS total_amount,
  pi.amount_paid,
  pi.outstanding_amount                             AS outstanding,
  CURRENT_DATE - COALESCE(pi.due_date, pi.invoice_date) AS days_overdue,
  CASE
    WHEN CURRENT_DATE <= COALESCE(pi.due_date, pi.invoice_date)      THEN 'NOT_DUE'
    WHEN CURRENT_DATE - COALESCE(pi.due_date, pi.invoice_date) <= 30 THEN '1_30'
    WHEN CURRENT_DATE - COALESCE(pi.due_date, pi.invoice_date) <= 60 THEN '31_60'
    WHEN CURRENT_DATE - COALESCE(pi.due_date, pi.invoice_date) <= 90 THEN '61_90'
    ELSE 'OVER_90'
  END AS ageing_bucket
FROM purchase_invoices pi
LEFT JOIN parties p ON p.id = pi.supplier_id
WHERE pi.status = 'POSTED'
  AND pi.outstanding_amount > 0;

-- ─── Day Book ────────────────────────────────────────────────
-- Chronological list of all POSTED documents.
CREATE OR REPLACE VIEW vw_day_book WITH (security_invoker = true) AS
SELECT
  jv.tenant_id, jv.organisation_id,
  jv.voucher_date  AS txn_date,
  jv.voucher_no    AS ref_no,
  'JOURNAL'::text  AS doc_type,
  jv.narration     AS description,
  jv.total_debit   AS debit_amount,
  jv.total_credit  AS credit_amount
FROM journal_vouchers jv
WHERE jv.status = 'POSTED'
UNION ALL
SELECT
  si.tenant_id, si.organisation_id,
  si.invoice_date, si.invoice_number, 'SALE_INVOICE',
  'Sale Invoice - ' || COALESCE(p.name, si.customer_name, 'Walk-in'),
  0::numeric, si.net_receivable
FROM sales_invoices si
LEFT JOIN parties p ON p.id = si.customer_id
WHERE si.status = 'POSTED'
UNION ALL
SELECT
  pi.tenant_id, pi.organisation_id,
  pi.invoice_date, pi.invoice_number, 'PURCHASE_INVOICE',
  'Purchase Invoice - ' || COALESCE(p.name, ''),
  pi.net_payable, 0::numeric
FROM purchase_invoices pi
LEFT JOIN parties p ON p.id = pi.supplier_id
WHERE pi.status = 'POSTED'
UNION ALL
SELECT
  pr.tenant_id, pr.organisation_id,
  pr.receipt_date, pr.receipt_no, 'RECEIPT',
  pr.narration,
  CASE WHEN pr.receipt_type::text = 'PAYMENT' THEN pr.amount ELSE 0 END,
  CASE WHEN pr.receipt_type::text = 'RECEIPT' THEN pr.amount ELSE 0 END
FROM payment_receipts pr
WHERE pr.status = 'POSTED';

GRANT SELECT ON vw_pl_summary, vw_trial_balance_full, vw_ageing_receivables,
                vw_ageing_payables, vw_day_book TO authenticated;
