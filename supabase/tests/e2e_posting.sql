-- ============================================================
-- End-to-end posting test (purchase -> sale -> credit note -> receipt -> locks)
-- Run against a scratch database that has migrations 001-038 applied
-- (with Supabase's `auth` schema / roles present):
--   psql -v ON_ERROR_STOP=1 -f supabase/tests/e2e_posting.sql <db>
-- Any failed assertion raises an exception; success prints "E2E PASSED".
-- ============================================================
\set ON_ERROR_STOP on
\set T  '''00000000-0000-0000-0000-0000000000a1'''
\set U  '''00000000-0000-0000-0000-0000000000a2'''
\set O  '''00000000-0000-0000-0000-0000000000a3'''
\set T2 '''00000000-0000-0000-0000-0000000000b1'''
\set U2 '''00000000-0000-0000-0000-0000000000b2'''

-- ── assertion helpers (public so the authenticated role can call them) ──
CREATE OR REPLACE FUNCTION public.t_eq(label text, got numeric, want numeric) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
  IF got IS DISTINCT FROM want THEN RAISE EXCEPTION 'FAIL [%]: got %, want %', label, got, want; END IF;
  RAISE NOTICE 'ok   %  = %', label, got;
END $$;

-- sum of debit/credit on account `code` in the journal for document `ref`
CREATE OR REPLACE FUNCTION public.t_jv(ref uuid, code text, side text) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(CASE WHEN side = 'dr' THEN l.debit_amount ELSE l.credit_amount END), 0)
    FROM journal_voucher_lines l
    JOIN journal_vouchers v ON v.id = l.voucher_id
    JOIN chart_of_accounts a ON a.id = l.account_id
   WHERE v.reference_id = ref AND a.account_code = code
$$;

CREATE OR REPLACE FUNCTION public.t_fails(label text, stmt text, expect text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM ILIKE '%' || expect || '%' THEN RAISE NOTICE 'ok   % (rejected: %)', label, SQLERRM; RETURN; END IF;
    RAISE EXCEPTION 'FAIL [%]: wrong error: %', label, SQLERRM;
  END;
  RAISE EXCEPTION 'FAIL [%]: expected an error containing "%", but it succeeded', label, expect;
END $$;
GRANT EXECUTE ON FUNCTION public.t_eq(text,numeric,numeric), public.t_jv(uuid,text,text),
                          public.t_fails(text,text,text) TO authenticated;

-- ── setup (as superuser, bypassing RLS) ──
INSERT INTO tenants(id, slug, name) VALUES (:T, 'e2e-1', 'E2E One'), (:T2, 'e2e-2', 'E2E Two');
SELECT onboard_tenant(:T, 'E2E One');
SELECT onboard_tenant(:T2, 'E2E Two');
INSERT INTO auth.users(id, email) VALUES (:U, 'a@e2e.test'), (:U2, 'b@e2e.test');
INSERT INTO user_profiles(id, tenant_id, full_name) VALUES (:U, :T, 'Admin One'), (:U2, :T2, 'Admin Two');
INSERT INTO organisations(id, tenant_id, legal_name) VALUES (:O, :T, 'E2E Agro');
INSERT INTO user_roles(tenant_id, user_id, role_id, organisation_id)
  SELECT :T, :U, id, :O FROM roles WHERE tenant_id = :T AND name = 'SUPER_ADMIN';
INSERT INTO locations(id, tenant_id, organisation_id, name, location_type)
  VALUES ('00000000-0000-0000-0000-0000000000c1', :T, :O, 'Main Godown', 'OWN');
INSERT INTO products(id, tenant_id, organisation_id, name, category, hsn_code, unit_of_measure, gst_rate, batch_required)
  VALUES ('00000000-0000-0000-0000-0000000000d1', :T, :O, 'Urea 45kg', 'FERTILIZER', '3102', 'BAG', 5, true);
INSERT INTO parties(id, tenant_id, organisation_id, name, party_type)
  VALUES ('00000000-0000-0000-0000-0000000000e1', :T, :O, 'Supplier Co', 'SUPPLIER'),
         ('00000000-0000-0000-0000-0000000000e2', :T, :O, 'Farmer Ram',  'CUSTOMER');
INSERT INTO chart_of_accounts(tenant_id, organisation_id, account_code, account_name, account_type, account_group)
SELECT :T, :O, c, n, t::account_type_enum, 'g' FROM (VALUES
 ('1001','Cash','ASSET'),('1002','Bank','ASSET'),('1010','Debtors','ASSET'),('1020','Stock','ASSET'),
 ('2001','Creditors','LIABILITY'),('2010','CGST Payable','LIABILITY'),('2011','SGST Payable','LIABILITY'),('2012','IGST Payable','LIABILITY'),
 ('3001','Sales Fert','INCOME'),('3002','Sales Seeds','INCOME'),('3003','Sales Pest','INCOME'),('3020','Other Income','INCOME'),
 ('4001','COGS Fert','EXPENSE'),('4002','COGS Seeds','EXPENSE'),('4003','COGS Pest','EXPENSE'),
 ('4040','ITC CGST','ASSET'),('4041','ITC SGST','ASSET'),('4042','ITC IGST','ASSET')) v(c,n,t);

-- ── act as the tenant-1 user ──
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :U, false);

-- 1. PURCHASE: 100 bags @ 10 = 1000 + 5% GST (25+25) = 1050 --------------------------------
INSERT INTO purchase_invoices(id, tenant_id, organisation_id, invoice_number, invoice_date, supplier_id, received_at_location,
   gross_amount, taxable_amount, cgst_amount, sgst_amount, net_payable, status)
VALUES ('00000000-0000-0000-0000-0000000001a1', :T, :O, 'PI-E2E-1', CURRENT_DATE, '00000000-0000-0000-0000-0000000000e1',
   '00000000-0000-0000-0000-0000000000c1', 1000, 1000, 25, 25, 1050, 'DRAFT');
INSERT INTO purchase_invoice_lines(invoice_id, tenant_id, line_no, product_id, hsn_code, received_qty, unit_of_measure, unit_price,
   taxable_amount, gst_rate, cgst_amount, sgst_amount, line_total, batch_number)
VALUES ('00000000-0000-0000-0000-0000000001a1', :T, 1, '00000000-0000-0000-0000-0000000000d1', '3102', 100, 'BAG', 10,
   1000, 5, 25, 25, 1050, 'B-001');
SELECT post_purchase_invoice('00000000-0000-0000-0000-0000000001a1');

SELECT t_eq('PI status POSTED', (SELECT (status = 'POSTED')::int FROM purchase_invoices WHERE invoice_number='PI-E2E-1'), 1);
SELECT t_eq('stock after purchase', (SELECT SUM(balance_qty) FROM stock_balance), 100);
SELECT t_eq('batch current_qty after purchase', (SELECT current_qty FROM batch_register WHERE batch_number='B-001'), 100);
SELECT t_eq('PI journal DR stock', t_jv('00000000-0000-0000-0000-0000000001a1','1020','dr'), 1000);
SELECT t_eq('PI journal DR ITC CGST', t_jv('00000000-0000-0000-0000-0000000001a1','4040','dr'), 25);
SELECT t_eq('PI journal CR creditors', t_jv('00000000-0000-0000-0000-0000000001a1','2001','cr'), 1050);
SELECT t_fails('double-post purchase invoice', $$SELECT post_purchase_invoice('00000000-0000-0000-0000-0000000001a1')$$, 'Only DRAFT');

-- 2. SALE: 40 bags @ 15 = 600 + 5% (15+15) = 630 on credit ---------------------------------
INSERT INTO sales_invoices(id, tenant_id, organisation_id, invoice_number, invoice_date, sale_type, customer_id, from_location,
   gross_amount, taxable_amount, cgst_amount, sgst_amount, net_receivable, status)
VALUES ('00000000-0000-0000-0000-0000000002a1', :T, :O, 'SI-E2E-1', CURRENT_DATE, 'CREDIT', '00000000-0000-0000-0000-0000000000e2',
   '00000000-0000-0000-0000-0000000000c1', 600, 600, 15, 15, 630, 'DRAFT');
INSERT INTO sales_invoice_lines(id, invoice_id, tenant_id, line_no, product_id, hsn_code, batch_id, qty, unit_of_measure, unit_price,
   taxable_amount, gst_rate, cgst_amount, sgst_amount, line_total)
VALUES ('00000000-0000-0000-0000-0000000003a1', '00000000-0000-0000-0000-0000000002a1', :T, 1, '00000000-0000-0000-0000-0000000000d1', '3102',
   (SELECT id FROM batch_register WHERE batch_number='B-001'), 40, 'BAG', 15, 600, 5, 15, 15, 630);
SELECT post_sales_invoice('00000000-0000-0000-0000-0000000002a1');

SELECT t_eq('stock after sale', (SELECT SUM(balance_qty) FROM stock_balance), 60);
SELECT t_eq('batch current_qty after sale', (SELECT current_qty FROM batch_register WHERE batch_number='B-001'), 60);
SELECT t_eq('SI journal DR debtors', t_jv('00000000-0000-0000-0000-0000000002a1','1010','dr'), 630);
SELECT t_eq('SI journal CR sales', t_jv('00000000-0000-0000-0000-0000000002a1','3001','cr'), 600);
SELECT t_eq('SI journal CR CGST payable', t_jv('00000000-0000-0000-0000-0000000002a1','2010','cr'), 15);
SELECT t_eq('SI journal DR COGS (40 x cost 10)', t_jv('00000000-0000-0000-0000-0000000002a1','4001','dr'), 400);
SELECT t_eq('SI journal CR stock', t_jv('00000000-0000-0000-0000-0000000002a1','1020','cr'), 400);
SELECT t_eq('SI outstanding', (SELECT outstanding_amount FROM sales_invoices WHERE invoice_number='SI-E2E-1'), 630);
SELECT t_fails('double-post sales invoice', $$SELECT post_sales_invoice('00000000-0000-0000-0000-0000000002a1')$$, 'Only DRAFT');

-- 3. OVERSELL is rejected and leaves no trace -----------------------------------------------
INSERT INTO sales_invoices(id, tenant_id, organisation_id, invoice_number, invoice_date, sale_type, customer_id, from_location,
   taxable_amount, cgst_amount, sgst_amount, net_receivable, status)
VALUES ('00000000-0000-0000-0000-0000000002a2', :T, :O, 'SI-E2E-2', CURRENT_DATE, 'CREDIT', '00000000-0000-0000-0000-0000000000e2',
   '00000000-0000-0000-0000-0000000000c1', 1500, 37.5, 37.5, 1575, 'DRAFT');
INSERT INTO sales_invoice_lines(invoice_id, tenant_id, line_no, product_id, hsn_code, batch_id, qty, unit_of_measure, unit_price,
   taxable_amount, gst_rate, cgst_amount, sgst_amount, line_total)
VALUES ('00000000-0000-0000-0000-0000000002a2', :T, 1, '00000000-0000-0000-0000-0000000000d1', '3102',
   (SELECT id FROM batch_register WHERE batch_number='B-001'), 100, 'BAG', 15, 1500, 5, 37.5, 37.5, 1575);
SELECT t_fails('oversell blocked', $$SELECT post_sales_invoice('00000000-0000-0000-0000-0000000002a2')$$, 'Insufficient stock');
SELECT t_eq('stock unchanged after rejected oversell', (SELECT SUM(balance_qty) FROM stock_balance), 60);
SELECT t_eq('oversell invoice still DRAFT', (SELECT (status='DRAFT')::int FROM sales_invoices WHERE invoice_number='SI-E2E-2'), 1);

-- 4. CREDIT NOTE: 10 bags back @ 15 = 150 + 7.5 GST = 157.5 ---------------------------------
INSERT INTO credit_notes(id, tenant_id, organisation_id, credit_note_number, credit_note_date, reason, original_invoice_id, customer_id,
   goods_returned, return_to_location, taxable_amount, cgst_amount, sgst_amount, total_amount, status)
VALUES ('00000000-0000-0000-0000-0000000004a1', :T, :O, 'CN-E2E-1', CURRENT_DATE, 'RETURN_OF_GOODS',
   '00000000-0000-0000-0000-0000000002a1', '00000000-0000-0000-0000-0000000000e2', true,
   '00000000-0000-0000-0000-0000000000c1', 150, 3.75, 3.75, 157.5, 'DRAFT');
INSERT INTO credit_note_lines(credit_note_id, tenant_id, original_line_id, product_id, hsn_code, batch_id, return_qty, unit_of_measure,
   unit_price, taxable_amount, gst_rate, cgst_amount, sgst_amount, line_total)
VALUES ('00000000-0000-0000-0000-0000000004a1', :T, '00000000-0000-0000-0000-0000000003a1', '00000000-0000-0000-0000-0000000000d1', '3102',
   (SELECT id FROM batch_register WHERE batch_number='B-001'), 10, 'BAG', 15, 150, 5, 3.75, 3.75, 157.5);
SELECT post_credit_note('00000000-0000-0000-0000-0000000004a1');

SELECT t_eq('stock after return', (SELECT SUM(balance_qty) FROM stock_balance), 70);
SELECT t_eq('batch current_qty after return', (SELECT current_qty FROM batch_register WHERE batch_number='B-001'), 70);
SELECT t_eq('CN journal CR debtors', t_jv('00000000-0000-0000-0000-0000000004a1','1010','cr'), 157.5);
SELECT t_eq('CN journal DR sales', t_jv('00000000-0000-0000-0000-0000000004a1','3001','dr'), 150);
SELECT t_eq('CN COGS reversal CR', t_jv('00000000-0000-0000-0000-0000000004a1','4001','cr'), 100);
SELECT t_eq('SI outstanding after CN', (SELECT outstanding_amount FROM sales_invoices WHERE invoice_number='SI-E2E-1'), 472.5);

-- over-return (50 more than the 30 still returnable) is rejected
INSERT INTO credit_notes(id, tenant_id, organisation_id, credit_note_number, credit_note_date, reason, original_invoice_id, customer_id,
   goods_returned, return_to_location, taxable_amount, cgst_amount, sgst_amount, total_amount, status)
VALUES ('00000000-0000-0000-0000-0000000004a2', :T, :O, 'CN-E2E-2', CURRENT_DATE, 'RETURN_OF_GOODS',
   '00000000-0000-0000-0000-0000000002a1', '00000000-0000-0000-0000-0000000000e2', true,
   '00000000-0000-0000-0000-0000000000c1', 450, 11.25, 11.25, 472.5, 'DRAFT');
INSERT INTO credit_note_lines(credit_note_id, tenant_id, original_line_id, product_id, hsn_code, batch_id, return_qty, unit_of_measure,
   unit_price, taxable_amount, gst_rate, cgst_amount, sgst_amount, line_total)
VALUES ('00000000-0000-0000-0000-0000000004a2', :T, '00000000-0000-0000-0000-0000000003a1', '00000000-0000-0000-0000-0000000000d1', '3102',
   (SELECT id FROM batch_register WHERE batch_number='B-001'), 31, 'BAG', 15, 450, 5, 11.25, 11.25, 472.5);
SELECT t_fails('over-return blocked', $$SELECT post_credit_note('00000000-0000-0000-0000-0000000004a2')$$, 'exceeds sold quantity');

-- 5. RECEIPT with allocation settles the invoice --------------------------------------------
INSERT INTO payment_receipts(id, tenant_id, organisation_id, receipt_no, receipt_date, receipt_type, party_id, payment_mode, amount, status)
VALUES ('00000000-0000-0000-0000-0000000005a1', :T, :O, 'RC-E2E-1', CURRENT_DATE, 'RECEIPT', '00000000-0000-0000-0000-0000000000e2', 'UPI', 472.5, 'DRAFT');
INSERT INTO receipt_allocations(tenant_id, receipt_id, invoice_type, invoice_id, allocated_amount)
VALUES (:T, '00000000-0000-0000-0000-0000000005a1', 'SALES_INVOICE', '00000000-0000-0000-0000-0000000002a1', 500);
SELECT t_fails('over-allocation blocked',
  $$SELECT rpc_post_payment_receipt('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000005a1','00000000-0000-0000-0000-0000000000a2',
      (SELECT id FROM chart_of_accounts WHERE account_code='1002'), (SELECT id FROM chart_of_accounts WHERE account_code='1010'))$$,
  'exceeds receipt amount');
UPDATE receipt_allocations SET allocated_amount = 472.5 WHERE receipt_id = '00000000-0000-0000-0000-0000000005a1';
SELECT rpc_post_payment_receipt('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000005a1','00000000-0000-0000-0000-0000000000a2',
  (SELECT id FROM chart_of_accounts WHERE account_code='1002'), (SELECT id FROM chart_of_accounts WHERE account_code='1010'));
SELECT t_eq('SI outstanding after receipt', (SELECT outstanding_amount FROM sales_invoices WHERE invoice_number='SI-E2E-1'), 0);

-- 6. Books balance: sum of all posted debits == credits; stock account == stock value ------
SELECT t_eq('trial balance debits = credits',
  (SELECT SUM(period_debit) - SUM(period_credit) FROM vw_trial_balance), 0);
-- stock value: bought 100 @10, sold 40 @10, returned 10 @10 => 70 units x 10 = 700
SELECT t_eq('stock account = 70 x cost 10',
  (SELECT period_debit - period_credit FROM vw_trial_balance WHERE account_code='1020'), 700);
SELECT t_eq('debtors fully settled',
  (SELECT period_debit - period_credit FROM vw_trial_balance WHERE account_code='1010'), 0);

-- 6b. Direct writes cannot bypass the posting engine
-- a user must not be able to mark a document POSTED directly
SELECT t_fails('direct status flip to POSTED blocked',
  $$UPDATE sales_invoices SET status = 'POSTED' WHERE invoice_number = 'SI-E2E-2'$$, 'row-level security');
SELECT t_fails('inserting an already-POSTED invoice blocked',
  $$INSERT INTO sales_invoices(tenant_id, organisation_id, invoice_number, status)
    VALUES ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000a3','SI-HACK','POSTED')$$, 'row-level security');
SELECT COUNT(*) AS jvn FROM journal_vouchers WHERE status = 'POSTED' \gset
DELETE FROM journal_vouchers WHERE status = 'POSTED';   -- RLS hides them: 0 rows deleted, no error
SELECT t_eq('posted vouchers survive a delete attempt', (SELECT COUNT(*) FROM journal_vouchers WHERE status = 'POSTED'), :jvn);


-- 7. PERIOD LOCK blocks posting into a locked month -----------------------------------------
-- a perfectly valid 5-bag invoice (so the ONLY reason to reject it is the lock)
INSERT INTO sales_invoices(id, tenant_id, organisation_id, invoice_number, invoice_date, sale_type, customer_id, from_location,
   gross_amount, taxable_amount, cgst_amount, sgst_amount, net_receivable, status)
VALUES ('00000000-0000-0000-0000-0000000002a3', :T, :O, 'SI-E2E-3', CURRENT_DATE, 'CREDIT', '00000000-0000-0000-0000-0000000000e2',
   '00000000-0000-0000-0000-0000000000c1', 75, 75, 1.875, 1.875, 78.75, 'DRAFT');
INSERT INTO sales_invoice_lines(invoice_id, tenant_id, line_no, product_id, hsn_code, batch_id, qty, unit_of_measure, unit_price,
   taxable_amount, gst_rate, cgst_amount, sgst_amount, line_total)
VALUES ('00000000-0000-0000-0000-0000000002a3', :T, 1, '00000000-0000-0000-0000-0000000000d1', '3102',
   (SELECT id FROM batch_register WHERE batch_number='B-001'), 5, 'BAG', 15, 75, 5, 1.875, 1.875, 78.75);
RESET ROLE;
INSERT INTO period_locks(tenant_id, organisation_id, lock_type, period_from, period_to, is_locked)
VALUES (:T, :O, 'FINANCIAL', date_trunc('month', CURRENT_DATE)::date, (date_trunc('month', CURRENT_DATE) + interval '1 month - 1 day')::date, true);
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :U, false);
SELECT t_fails('posting into locked period blocked', $$SELECT post_sales_invoice('00000000-0000-0000-0000-0000000002a3')$$, 'locked');
SELECT t_eq('stock unchanged after rejected locked-period post', (SELECT SUM(balance_qty) FROM stock_balance), 70);

-- 8. TENANT ISOLATION ----------------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', :U2, false);
SELECT t_eq('tenant 2 sees no invoices', (SELECT COUNT(*) FROM sales_invoices), 0);
SELECT t_eq('tenant 2 sees no stock', (SELECT COUNT(*) FROM stock_balance), 0);
SELECT t_fails('cross-tenant JV post blocked',
  $$SELECT rpc_post_journal_voucher('00000000-0000-0000-0000-0000000000a1', gen_random_uuid(), '00000000-0000-0000-0000-0000000000b2')$$,
  'Forbidden');
SELECT t_fails('cross-tenant sales post blocked', $$SELECT post_sales_invoice('00000000-0000-0000-0000-0000000002a3')$$, 'Invoice not found');
RESET ROLE;
DROP FUNCTION public.t_eq(text,numeric,numeric), public.t_jv(uuid,text,text), public.t_fails(text,text,text);
\echo E2E PASSED
