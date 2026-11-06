-- ============================================================
-- Migration 037: Accounting posting fixes
-- FertiLedger ERP
-- ============================================================
-- 1. rpc_post_journal_voucher / rpc_post_payment_receipt were SECURITY DEFINER
--    and trusted the tenant/user ids passed by the caller, so any signed-in user
--    could post into any tenant. They now require the ids to match the session.
-- 2. Posting a receipt now applies its receipt_allocations to the invoices
--    (sales_invoices.amount_received / purchase_invoices.amount_paid), which
--    previously never changed, so AR/AP outstanding never went down.
-- 3. vw_trial_balance counted lines of DRAFT/CANCELLED vouchers.
-- Signatures are unchanged so existing callers keep working.

-- ─── 1. Journal voucher posting ───────────────────────────────
CREATE OR REPLACE FUNCTION rpc_post_journal_voucher(
  p_tenant_id   UUID,
  p_voucher_id  UUID,
  p_user_id     UUID
) RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_debit   NUMERIC(18,2);
  v_credit  NUMERIC(18,2);
  v_lines   INT;
  v_org     UUID;
BEGIN
  IF p_tenant_id IS DISTINCT FROM public.get_tenant_id()
     OR p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT organisation_id INTO v_org
    FROM journal_vouchers
   WHERE id = p_voucher_id AND tenant_id = p_tenant_id AND status = 'DRAFT'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Voucher not found or not in DRAFT status';
  END IF;

  -- Every account must belong to this tenant/organisation
  IF EXISTS (
    SELECT 1 FROM journal_voucher_lines l
    LEFT JOIN chart_of_accounts a
      ON a.id = l.account_id AND a.tenant_id = p_tenant_id AND a.organisation_id = v_org
    WHERE l.voucher_id = p_voucher_id AND a.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Voucher references an account outside this organisation';
  END IF;

  -- A line is either a debit or a credit, never both / neither
  IF EXISTS (
    SELECT 1 FROM journal_voucher_lines
    WHERE voucher_id = p_voucher_id
      AND (debit_amount < 0 OR credit_amount < 0
           OR (debit_amount > 0 AND credit_amount > 0)
           OR (debit_amount = 0 AND credit_amount = 0))
  ) THEN
    RAISE EXCEPTION 'Each voucher line must have exactly one positive debit or credit amount';
  END IF;

  SELECT COALESCE(SUM(debit_amount), 0), COALESCE(SUM(credit_amount), 0), COUNT(*)
    INTO v_debit, v_credit, v_lines
    FROM journal_voucher_lines
   WHERE voucher_id = p_voucher_id AND tenant_id = p_tenant_id;

  IF v_lines < 2 THEN RAISE EXCEPTION 'A voucher needs at least two lines'; END IF;
  IF v_debit <> v_credit OR v_debit = 0 THEN
    RAISE EXCEPTION 'Voucher does not balance: Debit=% Credit=%', v_debit, v_credit;
  END IF;

  UPDATE journal_vouchers SET
    status = 'POSTED', total_debit = v_debit, total_credit = v_credit,
    posted_at = NOW(), posted_by = p_user_id, updated_by = p_user_id
  WHERE id = p_voucher_id AND tenant_id = p_tenant_id;
END;
$$;

-- ─── 2. Receipt / payment posting (+ invoice allocation) ──────
CREATE OR REPLACE FUNCTION rpc_post_payment_receipt(
  p_tenant_id       UUID,
  p_receipt_id      UUID,
  p_user_id         UUID,
  p_debit_account   UUID,
  p_credit_account  UUID
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_receipt    payment_receipts%ROWTYPE;
  v_jv_id      UUID;
  v_voucher_no TEXT;
  v_alloc_sum  NUMERIC(18,2);
  a            RECORD;
  v_outstanding NUMERIC(18,2);
  v_inv_party  UUID;
  v_inv_status TEXT;
BEGIN
  IF p_tenant_id IS DISTINCT FROM public.get_tenant_id()
     OR p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Forbidden' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_receipt
    FROM payment_receipts
   WHERE id = p_receipt_id AND tenant_id = p_tenant_id AND status = 'DRAFT'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Receipt not found or not in DRAFT status';
  END IF;
  IF v_receipt.amount IS NULL OR v_receipt.amount <= 0 THEN
    RAISE EXCEPTION 'Receipt amount must be positive';
  END IF;

  IF p_debit_account = p_credit_account THEN
    RAISE EXCEPTION 'Debit and credit accounts must differ';
  END IF;
  IF (SELECT COUNT(*) FROM chart_of_accounts
       WHERE id IN (p_debit_account, p_credit_account)
         AND tenant_id = p_tenant_id AND organisation_id = v_receipt.organisation_id) <> 2 THEN
    RAISE EXCEPTION 'Accounts must belong to this organisation';
  END IF;

  -- Allocations: validate, then apply to the invoices
  SELECT COALESCE(SUM(allocated_amount), 0) INTO v_alloc_sum
    FROM receipt_allocations WHERE receipt_id = p_receipt_id AND tenant_id = p_tenant_id;
  IF v_alloc_sum > v_receipt.amount THEN
    RAISE EXCEPTION 'Allocated amount (%) exceeds receipt amount (%)', v_alloc_sum, v_receipt.amount;
  END IF;

  FOR a IN
    SELECT * FROM receipt_allocations WHERE receipt_id = p_receipt_id AND tenant_id = p_tenant_id
  LOOP
    IF a.invoice_type = 'SALES_INVOICE' AND v_receipt.receipt_type = 'RECEIPT' THEN
      SELECT customer_id, status::text, outstanding_amount
        INTO v_inv_party, v_inv_status, v_outstanding
        FROM sales_invoices
       WHERE id = a.invoice_id AND tenant_id = p_tenant_id AND organisation_id = v_receipt.organisation_id
       FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Allocated sales invoice not found'; END IF;
      IF v_inv_status <> 'POSTED' THEN RAISE EXCEPTION 'Can only allocate to POSTED invoices'; END IF;
      IF v_inv_party IS DISTINCT FROM v_receipt.party_id THEN
        RAISE EXCEPTION 'Allocated invoice belongs to a different party';
      END IF;
      IF a.allocated_amount > v_outstanding THEN
        RAISE EXCEPTION 'Allocation (%) exceeds invoice outstanding (%)', a.allocated_amount, v_outstanding;
      END IF;
      UPDATE sales_invoices SET amount_received = amount_received + a.allocated_amount WHERE id = a.invoice_id;

    ELSIF a.invoice_type = 'PURCHASE_INVOICE' AND v_receipt.receipt_type = 'PAYMENT' THEN
      SELECT supplier_id, status::text, outstanding_amount
        INTO v_inv_party, v_inv_status, v_outstanding
        FROM purchase_invoices
       WHERE id = a.invoice_id AND tenant_id = p_tenant_id AND organisation_id = v_receipt.organisation_id
       FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Allocated purchase invoice not found'; END IF;
      IF v_inv_status <> 'POSTED' THEN RAISE EXCEPTION 'Can only allocate to POSTED invoices'; END IF;
      IF v_inv_party IS DISTINCT FROM v_receipt.party_id THEN
        RAISE EXCEPTION 'Allocated invoice belongs to a different party';
      END IF;
      IF a.allocated_amount > v_outstanding THEN
        RAISE EXCEPTION 'Allocation (%) exceeds invoice outstanding (%)', a.allocated_amount, v_outstanding;
      END IF;
      UPDATE purchase_invoices SET amount_paid = amount_paid + a.allocated_amount WHERE id = a.invoice_id;

    ELSE
      RAISE EXCEPTION 'Allocation type % does not match a % document', a.invoice_type, v_receipt.receipt_type;
    END IF;
  END LOOP;

  v_voucher_no := CASE v_receipt.receipt_type
    WHEN 'RECEIPT' THEN 'RV-' || TO_CHAR(v_receipt.receipt_date, 'YYYY') || '-' || LPAD(NEXTVAL('receipt_jv_seq')::TEXT, 5, '0')
    ELSE                 'PV-' || TO_CHAR(v_receipt.receipt_date, 'YYYY') || '-' || LPAD(NEXTVAL('receipt_jv_seq')::TEXT, 5, '0')
  END;

  INSERT INTO journal_vouchers (
    tenant_id, organisation_id, branch_id, voucher_no, voucher_date,
    voucher_type, reference_type, reference_id, narration, status,
    total_debit, total_credit, posted_at, posted_by, created_by, updated_by
  ) VALUES (
    p_tenant_id, v_receipt.organisation_id, v_receipt.branch_id, v_voucher_no, v_receipt.receipt_date,
    CASE v_receipt.receipt_type WHEN 'RECEIPT' THEN 'RECEIPT'::voucher_type_enum ELSE 'PAYMENT'::voucher_type_enum END,
    'PAYMENT_RECEIPT', p_receipt_id, COALESCE(v_receipt.narration, ''), 'POSTED',
    v_receipt.amount, v_receipt.amount, NOW(), p_user_id, p_user_id, p_user_id
  ) RETURNING id INTO v_jv_id;

  INSERT INTO journal_voucher_lines
    (tenant_id, voucher_id, line_no, account_id, party_id, debit_amount, credit_amount, narration)
  VALUES
    (p_tenant_id, v_jv_id, 1, p_debit_account,  v_receipt.party_id, v_receipt.amount, 0, v_receipt.narration),
    (p_tenant_id, v_jv_id, 2, p_credit_account, v_receipt.party_id, 0, v_receipt.amount, v_receipt.narration);

  UPDATE payment_receipts SET
    status = 'POSTED', journal_voucher_id = v_jv_id, updated_by = p_user_id
  WHERE id = p_receipt_id AND tenant_id = p_tenant_id;

  RETURN v_jv_id;
END;
$$;

-- ─── 3. Trial balance: only POSTED vouchers ───────────────────
-- (030's join attached lines of draft/cancelled vouchers because the status
--  condition was on the voucher join, not the line join.)
CREATE OR REPLACE VIEW vw_trial_balance WITH (security_invoker = true) AS
SELECT
  a.id                    AS account_id,
  a.tenant_id,
  a.account_code,
  a.account_name,
  a.account_type,
  a.account_group,
  a.opening_balance,
  a.opening_balance_type,
  COALESCE(SUM(pl.debit_amount),  0) AS period_debit,
  COALESCE(SUM(pl.credit_amount), 0) AS period_credit
FROM chart_of_accounts a
LEFT JOIN (
  SELECT l.account_id, l.debit_amount, l.credit_amount
  FROM journal_voucher_lines l
  JOIN journal_vouchers v ON v.id = l.voucher_id AND v.status = 'POSTED'
) pl ON pl.account_id = a.id
WHERE a.is_active = TRUE
GROUP BY a.id, a.tenant_id, a.account_code, a.account_name,
         a.account_type, a.account_group, a.opening_balance, a.opening_balance_type;
