-- ============================================================
-- FMS end-to-end test: subsidised farmer sale posting, PoS rules, ledger view, reconciliation
-- Requires migrations 001-040 on a scratch DB (see run_db_tests.sh).
-- ============================================================
\set ON_ERROR_STOP on
\set T  '''00000000-0000-0000-0000-00000000f001'''
\set U  '''00000000-0000-0000-0000-00000000f002'''
\set O  '''00000000-0000-0000-0000-00000000f003'''
\set T2 '''00000000-0000-0000-0000-00000000f101'''
\set U2 '''00000000-0000-0000-0000-00000000f102'''

CREATE OR REPLACE FUNCTION public.t_eq(label text, got numeric, want numeric) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
  IF got IS DISTINCT FROM want THEN RAISE EXCEPTION 'FAIL [%]: got %, want %', label, got, want; END IF;
  RAISE NOTICE 'ok   %  = %', label, got;
END $$;
CREATE OR REPLACE FUNCTION public.t_jv(ref uuid, code text, side text) RETURNS numeric
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(CASE WHEN side = 'dr' THEN l.debit_amount ELSE l.credit_amount END), 0)
    FROM journal_voucher_lines l JOIN journal_vouchers v ON v.id = l.voucher_id
    JOIN chart_of_accounts a ON a.id = l.account_id
   WHERE v.reference_id = ref AND a.account_code = code
$$;
CREATE OR REPLACE FUNCTION public.t_fails(label text, stmt text, expect text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
  BEGIN EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM ILIKE '%' || expect || '%' THEN RAISE NOTICE 'ok   % (rejected: %)', label, SQLERRM; RETURN; END IF;
    RAISE EXCEPTION 'FAIL [%]: wrong error: %', label, SQLERRM;
  END;
  RAISE EXCEPTION 'FAIL [%]: expected an error containing "%", but it succeeded', label, expect;
END $$;
GRANT EXECUTE ON FUNCTION public.t_eq(text,numeric,numeric), public.t_jv(uuid,text,text), public.t_fails(text,text,text) TO authenticated;

-- ── setup ──
INSERT INTO tenants(id, slug, name) VALUES (:T, 'fms-1', 'FMS One'), (:T2, 'fms-2', 'FMS Two');
SELECT onboard_tenant(:T, 'FMS One'); SELECT onboard_tenant(:T2, 'FMS Two');
INSERT INTO auth.users(id, email) VALUES (:U, 'f1@fms.test'), (:U2, 'f2@fms.test');
INSERT INTO user_profiles(id, tenant_id, full_name) VALUES (:U, :T, 'FMS Admin'), (:U2, :T2, 'Other Admin');
INSERT INTO organisations(id, tenant_id, legal_name) VALUES (:O, :T, 'FMS Agro');
INSERT INTO user_roles(tenant_id, user_id, role_id, organisation_id)
  SELECT :T, :U, id, :O FROM roles WHERE tenant_id = :T AND name = 'SUPER_ADMIN';
INSERT INTO locations(id, tenant_id, organisation_id, name, location_type)
  VALUES ('00000000-0000-0000-0000-00000000f0c1', :T, :O, 'Shop', 'OWN');
INSERT INTO products(id, tenant_id, organisation_id, name, category, hsn_code, unit_of_measure, gst_rate, batch_required)
  VALUES ('00000000-0000-0000-0000-00000000f0d1', :T, :O, 'Neem Urea 45kg', 'FERTILIZER', '3102', 'BAG', 5, true);
INSERT INTO farmers(id, tenant_id, organisation_id, first_name, last_name)
  VALUES ('00000000-0000-0000-0000-00000000f0f1', :T, :O, 'Ram', 'Kumar');
INSERT INTO chart_of_accounts(tenant_id, organisation_id, account_code, account_name, account_type, account_group)
SELECT :T, :O, c, n, t::account_type_enum, 'g' FROM (VALUES
 ('1001','Cash','ASSET'),('1010','Debtors','ASSET'),('1020','Stock','ASSET'),('1040','Subsidy Receivable','ASSET'),
 ('2010','CGST Payable','LIABILITY'),('2011','SGST Payable','LIABILITY'),
 ('3001','Sales Fert','INCOME'),('3002','Sales Seeds','INCOME'),('3003','Sales Pest','INCOME'),
 ('4001','COGS Fert','EXPENSE')) v(c,n,t);
-- opening stock: 100 bags in one batch at cost 10
INSERT INTO batch_register(id, tenant_id, organisation_id, batch_number, product_id, location_id, opening_qty, current_qty,
   unit_of_measure, purchase_rate, landing_cost_per_unit, status)
VALUES ('00000000-0000-0000-0000-00000000f0b1', :T, :O, 'NU-001', '00000000-0000-0000-0000-00000000f0d1',
   '00000000-0000-0000-0000-00000000f0c1', 100, 0, 'BAG', 10, 10, 'OPEN');
INSERT INTO stock_ledger(tenant_id, organisation_id, movement_type, product_id, batch_id, to_location_id, qty, unit_of_measure)
VALUES (:T, :O, 'OPENING', '00000000-0000-0000-0000-00000000f0d1', '00000000-0000-0000-0000-00000000f0b1',
   '00000000-0000-0000-0000-00000000f0c1', 100, 'BAG');

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :U, false);

-- 1. SUBSIDISED SALE: 10 bags @ 20, subsidy 15/bag => gross 200, subsidy 150, payable 50, GST 5% = 2.50, net 52.50 ----
INSERT INTO farmer_sales(id, tenant_id, organisation_id, sale_number, sale_date, farmer_id, farmer_name, sale_at_location,
   product_id, hsn_code, batch_id, batch_number, qty_sold, unit_of_measure, selling_price_per_unit, subsidy_per_unit,
   gross_amount, total_subsidy_amount, farmer_payable_amount, gst_rate, gst_amount, net_amount, cash_received, credit_amount,
   subsidy_type, fms_dealer_id, fms_product_code, pos_transaction_id, status)
VALUES ('00000000-0000-0000-0000-00000000f1a1', :T, :O, 'FS-T-1', CURRENT_DATE, '00000000-0000-0000-0000-00000000f0f1', 'Ram Kumar',
   '00000000-0000-0000-0000-00000000f0c1', '00000000-0000-0000-0000-00000000f0d1', '3102',
   '00000000-0000-0000-0000-00000000f0b1', 'NU-001', 10, 'BAG', 20, 15, 200, 150, 50, 5, 2.5, 52.5, 52.5, 0,
   'NEEM_COATED_UREA', 'DLR-77', 'UREA45', 'POS-0001', 'POS_RECORDED');
SELECT post_farmer_sale('00000000-0000-0000-0000-00000000f1a1');

SELECT t_eq('FS posted', (SELECT (status = 'POSTED')::int FROM farmer_sales WHERE sale_number = 'FS-T-1'), 1);
SELECT t_eq('stock after farmer sale', (SELECT SUM(balance_qty) FROM stock_balance), 90);
SELECT t_eq('batch current_qty after farmer sale', (SELECT current_qty FROM batch_register WHERE batch_number = 'NU-001'), 90);
SELECT t_eq('FS journal DR cash', t_jv('00000000-0000-0000-0000-00000000f1a1', '1001', 'dr'), 52.5);
SELECT t_eq('FS journal DR subsidy receivable', t_jv('00000000-0000-0000-0000-00000000f1a1', '1040', 'dr'), 150);
SELECT t_eq('FS journal CR sales (gross)', t_jv('00000000-0000-0000-0000-00000000f1a1', '3001', 'cr'), 200);
SELECT t_eq('FS journal CR CGST', t_jv('00000000-0000-0000-0000-00000000f1a1', '2010', 'cr'), 1.25);
SELECT t_eq('FS journal CR SGST', t_jv('00000000-0000-0000-0000-00000000f1a1', '2011', 'cr'), 1.25);
SELECT t_eq('FS journal DR COGS (10 x 10)', t_jv('00000000-0000-0000-0000-00000000f1a1', '4001', 'dr'), 100);
SELECT t_eq('trial balance balances', (SELECT SUM(period_debit) - SUM(period_credit) FROM vw_trial_balance), 0);
SELECT t_eq('stock moved as FMS_SUBSIDY_OUT with PoS ref',
  (SELECT COUNT(*) FROM stock_ledger WHERE movement_type = 'FMS_SUBSIDY_OUT' AND fms_transaction_id = 'POS-0001'), 1);
SELECT t_fails('double-post rejected', $$SELECT post_farmer_sale('00000000-0000-0000-0000-00000000f1a1')$$, 'Only POS_PENDING');

-- 2. COMPLIANCE RULES ------------------------------------------------------------------------
-- subsidised sale with no PoS id cannot be posted
INSERT INTO farmer_sales(id, tenant_id, organisation_id, sale_number, sale_date, farmer_id, farmer_name, sale_at_location,
   product_id, hsn_code, batch_id, qty_sold, unit_of_measure, selling_price_per_unit, subsidy_per_unit,
   gross_amount, total_subsidy_amount, farmer_payable_amount, gst_rate, gst_amount, net_amount, cash_received, credit_amount,
   subsidy_type, fms_dealer_id, fms_product_code, status)
VALUES ('00000000-0000-0000-0000-00000000f1a2', :T, :O, 'FS-T-2', CURRENT_DATE, '00000000-0000-0000-0000-00000000f0f1', 'Ram Kumar',
   '00000000-0000-0000-0000-00000000f0c1', '00000000-0000-0000-0000-00000000f0d1', '3102', '00000000-0000-0000-0000-00000000f0b1',
   5, 'BAG', 20, 15, 100, 75, 25, 5, 1.25, 26.25, 26.25, 0, 'NEEM_COATED_UREA', 'DLR-77', 'UREA45', 'POS_PENDING');
SELECT t_fails('subsidy without PoS blocked', $$SELECT post_farmer_sale('00000000-0000-0000-0000-00000000f1a2')$$, 'PoS transaction ID');
SELECT t_eq('ledger flags the missing PoS', (SELECT COUNT(*) FROM vw_fms_ledger WHERE sale_number = 'FS-T-2' AND compliance_flag = 'MISSING_POS'), 1);
SELECT t_eq('ledger shows posted sale as OK', (SELECT COUNT(*) FROM vw_fms_ledger WHERE sale_number = 'FS-T-1' AND compliance_flag = 'OK'), 1);

-- a PoS transaction id can never be reused (duplicate-subsidy prevention)
SELECT t_fails('duplicate PoS id blocked', $$
  INSERT INTO farmer_sales(tenant_id, organisation_id, sale_number, sale_date, farmer_id, farmer_name, sale_at_location,
     product_id, hsn_code, qty_sold, unit_of_measure, selling_price_per_unit, subsidy_type, pos_transaction_id, status)
  VALUES ('00000000-0000-0000-0000-00000000f001','00000000-0000-0000-0000-00000000f003','FS-T-DUP', CURRENT_DATE,
     '00000000-0000-0000-0000-00000000f0f1','Ram Kumar','00000000-0000-0000-0000-00000000f0c1',
     '00000000-0000-0000-0000-00000000f0d1','3102', 1, 'BAG', 20, 'NEEM_COATED_UREA', 'POS-0001', 'POS_RECORDED')$$, 'uq_fs_pos_tx_norm');
SELECT t_fails('duplicate PoS id blocked even with different case/spaces', $$
  INSERT INTO farmer_sales(tenant_id, organisation_id, sale_number, sale_date, farmer_id, farmer_name, sale_at_location,
     product_id, hsn_code, qty_sold, unit_of_measure, selling_price_per_unit, subsidy_type, pos_transaction_id, status)
  VALUES ('00000000-0000-0000-0000-00000000f001','00000000-0000-0000-0000-00000000f003','FS-T-DUP2', CURRENT_DATE,
     '00000000-0000-0000-0000-00000000f0f1','Ram Kumar','00000000-0000-0000-0000-00000000f0c1',
     '00000000-0000-0000-0000-00000000f0d1','3102', 1, 'BAG', 20, 'NEEM_COATED_UREA', ' pos-0001 ', 'POS_RECORDED')$$, 'uq_fs_pos_tx_norm');

-- tampered amounts are rejected at posting time
INSERT INTO farmer_sales(id, tenant_id, organisation_id, sale_number, sale_date, farmer_id, farmer_name, sale_at_location,
   product_id, hsn_code, batch_id, qty_sold, unit_of_measure, selling_price_per_unit, subsidy_per_unit,
   gross_amount, total_subsidy_amount, farmer_payable_amount, gst_rate, gst_amount, net_amount, cash_received, credit_amount,
   subsidy_type, pos_transaction_id, status)
VALUES ('00000000-0000-0000-0000-00000000f1a3', :T, :O, 'FS-T-3', CURRENT_DATE, '00000000-0000-0000-0000-00000000f0f1', 'Ram Kumar',
   '00000000-0000-0000-0000-00000000f0c1', '00000000-0000-0000-0000-00000000f0d1', '3102', '00000000-0000-0000-0000-00000000f0b1',
   5, 'BAG', 20, 0, 1, 0, 1, 0, 0, 1, 1, 0, 'NONE', NULL, 'POS_PENDING');
SELECT t_fails('tampered amounts rejected', $$SELECT post_farmer_sale('00000000-0000-0000-0000-00000000f1a3')$$, 'inconsistent');

-- oversell rejected
INSERT INTO farmer_sales(id, tenant_id, organisation_id, sale_number, sale_date, farmer_id, farmer_name, sale_at_location,
   product_id, hsn_code, batch_id, qty_sold, unit_of_measure, selling_price_per_unit, subsidy_per_unit,
   gross_amount, total_subsidy_amount, farmer_payable_amount, gst_rate, gst_amount, net_amount, cash_received, credit_amount,
   subsidy_type, status)
VALUES ('00000000-0000-0000-0000-00000000f1a4', :T, :O, 'FS-T-4', CURRENT_DATE, '00000000-0000-0000-0000-00000000f0f1', 'Ram Kumar',
   '00000000-0000-0000-0000-00000000f0c1', '00000000-0000-0000-0000-00000000f0d1', '3102', '00000000-0000-0000-0000-00000000f0b1',
   500, 'BAG', 20, 0, 10000, 0, 10000, 0, 0, 10000, 10000, 0, 'NONE', 'POS_PENDING');
SELECT t_fails('oversell rejected', $$SELECT post_farmer_sale('00000000-0000-0000-0000-00000000f1a4')$$, 'Insufficient stock');
SELECT t_eq('stock unchanged after rejects', (SELECT SUM(balance_qty) FROM stock_balance), 90);

-- users cannot post by hand
SELECT t_fails('direct flip to POSTED blocked', $$UPDATE farmer_sales SET status = 'POSTED' WHERE sale_number = 'FS-T-2'$$, 'row-level security');

-- 3. RECONCILIATION --------------------------------------------------------------------------
SELECT t_eq('matching reconciliation',
  (SELECT (reconciliation_status = 'MATCHED')::int FROM run_fms_reconciliation(
     '00000000-0000-0000-0000-00000000f003', date_trunc('month', CURRENT_DATE)::date, CURRENT_DATE, 'DLR-77', 'UREA45', 10, 1, 150)), 1);
SELECT t_eq('system figures captured', (SELECT system_total_qty FROM fms_reconciliation ORDER BY created_at DESC LIMIT 1), 10);
SELECT t_eq('variance reconciliation flagged',
  (SELECT (reconciliation_status = 'VARIANCE')::int FROM run_fms_reconciliation(
     '00000000-0000-0000-0000-00000000f003', date_trunc('month', CURRENT_DATE)::date, CURRENT_DATE, 'DLR-77', 'UREA45', 12, 1, 150, 'FMS shows extra bags')), 1);
SELECT t_eq('qty variance computed', (SELECT qty_variance FROM fms_reconciliation WHERE reconciliation_status = 'VARIANCE'), 2);
SELECT t_fails('resolve needs remarks',
  $$SELECT resolve_fms_reconciliation((SELECT id FROM fms_reconciliation WHERE reconciliation_status = 'VARIANCE'), '  ')$$, 'remarks are required');
SELECT resolve_fms_reconciliation((SELECT id FROM fms_reconciliation WHERE reconciliation_status = 'VARIANCE'), 'Portal double-counted a reversed bill');
SELECT t_eq('variance resolved', (SELECT COUNT(*) FROM fms_reconciliation WHERE reconciliation_status = 'RESOLVED'), 1);
SELECT t_fails('cannot resolve a matched reconciliation twice',
  $$SELECT resolve_fms_reconciliation((SELECT id FROM fms_reconciliation WHERE reconciliation_status = 'RESOLVED'), 'again')$$, 'not awaiting');

-- 3b. CANCEL & REISSUE ------------------------------------------------------------------------
SELECT t_fails('cancel needs a reason', $$SELECT cancel_farmer_sale('00000000-0000-0000-0000-00000000f1a1', '  ')$$, 'reason is required');
SELECT t_fails('reissue must use a NEW PoS id',
  $$SELECT reissue_farmer_sale('00000000-0000-0000-0000-00000000f1a1', 'wrong qty', ' pos-0001')$$, 'must differ');
SELECT t_fails('reissue needs a PoS id', $$SELECT reissue_farmer_sale('00000000-0000-0000-0000-00000000f1a1', 'wrong qty', '')$$, 'new PoS transaction ID is required');
SELECT t_fails('reissue rejects subsidy above price',
  $$SELECT reissue_farmer_sale('00000000-0000-0000-0000-00000000f1a1', 'x', 'POS-BAD', 8, 20, 25)$$, 'subsidy per unit');
SELECT t_eq('failed reissue attempts changed nothing', (SELECT COUNT(*) FROM farmer_sales WHERE status = 'CANCELLED'), 0);

-- cancel & reissue the POSTED sale with a corrected quantity (8 instead of 10)
SELECT reissue_farmer_sale('00000000-0000-0000-0000-00000000f1a1', 'Wrong quantity keyed at PoS', 'POS-0002', 8, 20, 15);
SELECT t_eq('original is CANCELLED', (SELECT (status = 'CANCELLED')::int FROM farmer_sales WHERE sale_number = 'FS-T-1'), 1);
SELECT t_eq('original linked to replacement', (SELECT (reissued_as_id IS NOT NULL)::int FROM farmer_sales WHERE sale_number = 'FS-T-1'), 1);
SELECT t_eq('replacement is POS_RECORDED with new PoS id',
  (SELECT COUNT(*) FROM farmer_sales WHERE pos_transaction_id = 'POS-0002' AND status = 'POS_RECORDED' AND reissued_from_id IS NOT NULL), 1);
SELECT t_eq('replacement amounts recomputed (8 x 20 = 160 gross)', (SELECT gross_amount FROM farmer_sales WHERE pos_transaction_id = 'POS-0002'), 160);
SELECT t_eq('replacement subsidy recomputed (8 x 15)', (SELECT total_subsidy_amount FROM farmer_sales WHERE pos_transaction_id = 'POS-0002'), 120);
SELECT t_eq('replacement net (40 + 5% GST = 42)', (SELECT net_amount FROM farmer_sales WHERE pos_transaction_id = 'POS-0002'), 42);
SELECT t_eq('stock fully restored by the reversal', (SELECT SUM(balance_qty) FROM stock_balance), 100);
SELECT t_eq('batch qty restored', (SELECT current_qty FROM batch_register WHERE batch_number = 'NU-001'), 100);
SELECT t_eq('subsidy receivable reversed to nil',
  (SELECT period_debit - period_credit FROM vw_trial_balance WHERE account_code = '1040'), 0);
SELECT t_eq('sales revenue reversed to nil',
  (SELECT period_credit - period_debit FROM vw_trial_balance WHERE account_code = '3001'), 0);
SELECT t_eq('COGS reversed to nil', (SELECT period_debit - period_credit FROM vw_trial_balance WHERE account_code = '4001'), 0);
SELECT t_eq('books still balance after reversal', (SELECT SUM(period_debit) - SUM(period_credit) FROM vw_trial_balance), 0);
SELECT t_eq('ledger flags the cancelled sale', (SELECT COUNT(*) FROM vw_fms_ledger WHERE sale_number = 'FS-T-1' AND compliance_flag = 'CANCELLED'), 1);
SELECT t_fails('cancelling twice rejected', $$SELECT cancel_farmer_sale('00000000-0000-0000-0000-00000000f1a1', 'again')$$, 'already cancelled');
-- the cancelled sale's PoS id stays burned
SELECT t_fails('old PoS id can never be reused', $$
  INSERT INTO farmer_sales(tenant_id, organisation_id, sale_number, sale_date, farmer_id, farmer_name, sale_at_location,
     product_id, hsn_code, qty_sold, unit_of_measure, selling_price_per_unit, subsidy_type, pos_transaction_id, status)
  VALUES ('00000000-0000-0000-0000-00000000f001','00000000-0000-0000-0000-00000000f003','FS-T-REUSE', CURRENT_DATE,
     '00000000-0000-0000-0000-00000000f0f1','Ram Kumar','00000000-0000-0000-0000-00000000f0c1',
     '00000000-0000-0000-0000-00000000f0d1','3102', 1, 'BAG', 20, 'NEEM_COATED_UREA', 'POS-0001', 'POS_RECORDED')$$, 'uq_fs_pos_tx_norm');

-- the replacement goes through the normal posting checks and posts correctly
SELECT post_farmer_sale((SELECT id FROM farmer_sales WHERE pos_transaction_id = 'POS-0002'));
SELECT t_eq('stock after posting replacement (100 - 8)', (SELECT SUM(balance_qty) FROM stock_balance), 92);
SELECT t_eq('replacement DR subsidy receivable 120',
  (SELECT t_jv(id, '1040', 'dr') FROM farmer_sales WHERE pos_transaction_id = 'POS-0002'), 120);

-- once subsidy is claimed the sale can no longer be cancelled from here
RESET ROLE;
UPDATE farmer_sales SET status = 'SUBSIDY_CLAIMED' WHERE pos_transaction_id = 'POS-0002';
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :U, false);
SELECT t_fails('claimed subsidy blocks cancellation',
  $$SELECT cancel_farmer_sale((SELECT id FROM farmer_sales WHERE pos_transaction_id = 'POS-0002'), 'try')$$, 'already subsidy claimed');
RESET ROLE;
UPDATE farmer_sales SET status = 'POSTED' WHERE pos_transaction_id = 'POS-0002';
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :U, false);

-- a pre-posting sale can be cancelled with no accounting effect
SELECT cancel_farmer_sale('00000000-0000-0000-0000-00000000f1a2', 'Customer changed mind');
SELECT t_eq('pre-posting cancel just marks CANCELLED', (SELECT (status = 'CANCELLED')::int FROM farmer_sales WHERE sale_number = 'FS-T-2'), 1);
SELECT t_eq('no journal for a cancelled unposted sale',
  (SELECT COUNT(*) FROM journal_vouchers WHERE reference_id = '00000000-0000-0000-0000-00000000f1a2'), 0);
SELECT t_eq('stock untouched by unposted cancel', (SELECT SUM(balance_qty) FROM stock_balance), 92);

-- 4. TENANT ISOLATION ------------------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', :U2, false);
SELECT t_eq('other tenant sees no FMS ledger', (SELECT COUNT(*) FROM vw_fms_ledger), 0);
SELECT t_fails('cross-tenant posting blocked', $$SELECT post_farmer_sale('00000000-0000-0000-0000-00000000f1a2')$$, 'not found');
SELECT t_fails('cross-tenant cancel blocked', $$SELECT cancel_farmer_sale('00000000-0000-0000-0000-00000000f1a1', 'hack')$$, 'not found');
SELECT t_fails('cross-tenant reissue blocked', $$SELECT reissue_farmer_sale('00000000-0000-0000-0000-00000000f1a1', 'hack', 'POS-X')$$, 'not found');

RESET ROLE;
DROP FUNCTION public.t_eq(text,numeric,numeric), public.t_jv(uuid,text,text), public.t_fails(text,text,text);
\echo E2E PASSED
