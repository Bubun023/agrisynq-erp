-- ============================================================
-- Migration 034: Reports Views
-- Phase 11 - FertiLedger ERP
-- ============================================================

-- ─── P&L Summary View ────────────────────────────────────────
-- Income vs Expense from Chart of Accounts + Journal Vouchers
CREATE OR REPLACE VIEW vw_pl_summary AS
WITH jv_lines AS (
  SELECT
    jvl.organisation_id,
    jvl.account_id,
    coa.account_type,
    coa.account_name,
    coa.account_code,
    jv.voucher_date,
    DATE_PART('year', jv.voucher_date)::int  AS fyear,
    DATE_PART('month', jv.voucher_date)::int AS fmonth,
    jvl.debit_amount,
    jvl.credit_amount
  FROM journal_voucher_lines jvl
  JOIN journal_vouchers jv   ON jv.id  = jvl.voucher_id
  JOIN chart_of_accounts coa ON coa.id = jvl.account_id
  WHERE jv.status = 'POSTED'
)
SELECT
  organisation_id,
  fyear,
  fmonth,
  account_type,
  account_code,
  account_name,
  SUM(CASE
    WHEN account_type = 'INCOME'  THEN credit_amount - debit_amount
    WHEN account_type = 'EXPENSE' THEN debit_amount  - credit_amount
    ELSE 0
  END) AS net_amount
FROM jv_lines
WHERE account_type IN ('INCOME', 'EXPENSE')
GROUP BY organisation_id, fyear, fmonth, account_type, account_code, account_name;

-- ─── Trial Balance View (enhanced) ───────────────────────────
CREATE OR REPLACE VIEW vw_trial_balance_full AS
WITH jv_totals AS (
  SELECT
    jvl.organisation_id,
    jvl.account_id,
    SUM(jvl.debit_amount)  AS total_debit,
    SUM(jvl.credit_amount) AS total_credit
  FROM journal_voucher_lines jvl
  JOIN journal_vouchers jv ON jv.id = jvl.voucher_id
  WHERE jv.status = 'POSTED'
  GROUP BY jvl.organisation_id, jvl.account_id
)
SELECT
  coa.organisation_id,
  coa.id             AS account_id,
  coa.account_code,
  coa.account_name,
  coa.account_type,
  coa.parent_id,
  COALESCE(jt.total_debit,  0) AS total_debit,
  COALESCE(jt.total_credit, 0) AS total_credit,
  COALESCE(jt.total_debit, 0) - COALESCE(jt.total_credit, 0) AS net_balance
FROM chart_of_accounts coa
LEFT JOIN jv_totals jt ON jt.account_id = coa.id AND jt.organisation_id = coa.organisation_id
WHERE coa.is_active = true;

-- ─── Outstanding Ageing — Receivables ────────────────────────
CREATE OR REPLACE VIEW vw_ageing_receivables AS
SELECT
  si.organisation_id,
  si.party_id,
  p.party_name,
  p.gstin,
  si.invoice_no,
  si.invoice_date,
  si.due_date,
  si.total_amount,
  COALESCE(si.amount_paid, 0)                 AS amount_paid,
  si.total_amount - COALESCE(si.amount_paid, 0) AS outstanding,
  CURRENT_DATE - COALESCE(si.due_date, si.invoice_date) AS days_overdue,
  CASE
    WHEN CURRENT_DATE <= COALESCE(si.due_date, si.invoice_date)           THEN 'NOT_DUE'
    WHEN CURRENT_DATE - COALESCE(si.due_date, si.invoice_date) <= 30      THEN '1_30'
    WHEN CURRENT_DATE - COALESCE(si.due_date, si.invoice_date) <= 60      THEN '31_60'
    WHEN CURRENT_DATE - COALESCE(si.due_date, si.invoice_date) <= 90      THEN '61_90'
    ELSE 'OVER_90'
  END AS ageing_bucket
FROM sales_invoices si
JOIN parties p ON p.id = si.party_id
WHERE si.status = 'POSTED'
  AND si.total_amount - COALESCE(si.amount_paid, 0) > 0;

-- ─── Outstanding Ageing — Payables ───────────────────────────
CREATE OR REPLACE VIEW vw_ageing_payables AS
SELECT
  pi.organisation_id,
  pi.party_id,
  p.party_name,
  p.gstin,
  pi.invoice_no,
  pi.invoice_date,
  pi.due_date,
  pi.total_amount,
  COALESCE(pi.amount_paid, 0)                  AS amount_paid,
  pi.total_amount - COALESCE(pi.amount_paid, 0) AS outstanding,
  CURRENT_DATE - COALESCE(pi.due_date, pi.invoice_date) AS days_overdue,
  CASE
    WHEN CURRENT_DATE <= COALESCE(pi.due_date, pi.invoice_date)          THEN 'NOT_DUE'
    WHEN CURRENT_DATE - COALESCE(pi.due_date, pi.invoice_date) <= 30     THEN '1_30'
    WHEN CURRENT_DATE - COALESCE(pi.due_date, pi.invoice_date) <= 60     THEN '31_60'
    WHEN CURRENT_DATE - COALESCE(pi.due_date, pi.invoice_date) <= 90     THEN '61_90'
    ELSE 'OVER_90'
  END AS ageing_bucket
FROM purchase_invoices pi
JOIN parties p ON p.id = pi.party_id
WHERE pi.status = 'POSTED'
  AND pi.total_amount - COALESCE(pi.amount_paid, 0) > 0;

-- ─── Day Book View ────────────────────────────────────────────
CREATE OR REPLACE VIEW vw_day_book AS
SELECT
  jv.organisation_id,
  jv.voucher_date         AS txn_date,
  jv.voucher_no           AS ref_no,
  'JOURNAL'               AS doc_type,
  jv.narration            AS description,
  jv.total_debit          AS debit_amount,
  jv.total_credit         AS credit_amount
FROM journal_vouchers jv
WHERE jv.status = 'POSTED'
UNION ALL
SELECT
  si.organisation_id,
  si.invoice_date,
  si.invoice_no,
  'SALE_INVOICE',
  'Sale Invoice - ' || p.party_name,
  0,
  si.total_amount
FROM sales_invoices si
JOIN parties p ON p.id = si.party_id
WHERE si.status = 'POSTED'
UNION ALL
SELECT
  pi.organisation_id,
  pi.invoice_date,
  pi.invoice_no,
  'PURCHASE_INVOICE',
  'Purchase Invoice - ' || p.party_name,
  pi.total_amount,
  0
FROM purchase_invoices pi
JOIN parties p ON p.id = pi.party_id
WHERE pi.status = 'POSTED'
UNION ALL
SELECT
  pr.organisation_id,
  pr.receipt_date,
  pr.receipt_no,
  'RECEIPT',
  pr.narration,
  CASE WHEN pr.payment_type = 'PAYMENT' THEN pr.amount ELSE 0 END,
  CASE WHEN pr.payment_type = 'RECEIPT' THEN pr.amount ELSE 0 END
FROM payment_receipts pr;

GRANT SELECT ON vw_pl_summary          TO authenticated;
GRANT SELECT ON vw_trial_balance_full  TO authenticated;
GRANT SELECT ON vw_ageing_receivables  TO authenticated;
GRANT SELECT ON vw_ageing_payables     TO authenticated;
GRANT SELECT ON vw_day_book            TO authenticated;
