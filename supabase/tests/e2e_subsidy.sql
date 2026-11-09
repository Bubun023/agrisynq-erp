-- ============================================================
-- Subsidy claims end-to-end test (requires migrations 001-043)
-- ============================================================
\set ON_ERROR_STOP on
\set T  '''00000000-0000-0000-0000-00000000d001'''
\set U  '''00000000-0000-0000-0000-00000000d002'''
\set O  '''00000000-0000-0000-0000-00000000d003'''
\set T2 '''00000000-0000-0000-0000-00000000d101'''
\set U2 '''00000000-0000-0000-0000-00000000d102'''

CREATE OR REPLACE FUNCTION public.t_eq(label text, got numeric, want numeric) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
  IF got IS DISTINCT FROM want THEN RAISE EXCEPTION 'FAIL [%]: got %, want %', label, got, want; END IF;
  RAISE NOTICE 'ok   %  = %', label, got;
END $$;
CREATE OR REPLACE FUNCTION public.t_fails(label text, stmt text, expect text) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
  BEGIN EXECUTE stmt;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM ILIKE '%' || expect || '%' THEN RAISE NOTICE 'ok   % (rejected: %)', label, SQLERRM; RETURN; END IF;
    RAISE EXCEPTION 'FAIL [%]: wrong error: %', label, SQLERRM;
  END;
  RAISE EXCEPTION 'FAIL [%]: expected an error containing "%", but it succeeded', label, expect;
END $$;
-- books: balance of an account (debit - credit)
CREATE OR REPLACE FUNCTION public.t_bal(code text) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(period_debit - period_credit), 0) FROM vw_trial_balance WHERE account_code = code $$;
-- create + post a subsidised sale: qty bags @20, subsidy 15/bag, 5% GST on what the farmer pays, paid in cash
CREATE OR REPLACE FUNCTION public.t_sale(n text, pos text, qty numeric) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE id uuid := gen_random_uuid(); pay numeric := qty * 5; gst numeric := round(qty * 5 * 0.05, 2);
BEGIN
  INSERT INTO farmer_sales(id, tenant_id, organisation_id, sale_number, sale_date, farmer_id, farmer_name, sale_at_location,
     product_id, hsn_code, batch_id, qty_sold, unit_of_measure, selling_price_per_unit, subsidy_per_unit, gross_amount,
     total_subsidy_amount, farmer_payable_amount, gst_rate, gst_amount, net_amount, cash_received, credit_amount,
     subsidy_type, fms_dealer_id, pos_transaction_id, status)
  VALUES (id, '00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-00000000d003', n, CURRENT_DATE,
     '00000000-0000-0000-0000-00000000d0f1', 'Gita Devi', '00000000-0000-0000-0000-00000000d0c1',
     '00000000-0000-0000-0000-00000000d0d1', '3102', '00000000-0000-0000-0000-00000000d0b1', qty, 'BAG', 20, 15, qty * 20,
     qty * 15, pay, 5, gst, pay + gst, pay + gst, 0, 'NEEM_COATED_UREA', 'DLR-5', pos, 'POS_RECORDED');
  PERFORM post_farmer_sale(id);
  RETURN id;
END $$;
GRANT EXECUTE ON FUNCTION public.t_eq(text,numeric,numeric), public.t_fails(text,text,text), public.t_bal(text),
                          public.t_sale(text,text,numeric) TO authenticated;

-- ── setup ──
INSERT INTO tenants(id, slug, name) VALUES (:T, 'sub-1', 'Sub One'), (:T2, 'sub-2', 'Sub Two');
SELECT onboard_tenant(:T, 'Sub One'); SELECT onboard_tenant(:T2, 'Sub Two');
INSERT INTO auth.users(id, email) VALUES (:U, 's1@sub.test'), (:U2, 's2@sub.test');
INSERT INTO user_profiles(id, tenant_id, full_name) VALUES (:U, :T, 'Sub Admin'), (:U2, :T2, 'Other Admin');
INSERT INTO organisations(id, tenant_id, legal_name) VALUES (:O, :T, 'Sub Agro');
INSERT INTO user_roles(tenant_id, user_id, role_id, organisation_id)
  SELECT :T, :U, id, :O FROM roles WHERE tenant_id = :T AND name = 'SUPER_ADMIN';
-- the OTHER company's user is a real admin of their own company, so cross-tenant checks are what stops them (not a missing role)
INSERT INTO user_roles(tenant_id, user_id, role_id)
  SELECT :T2, :U2, id FROM roles WHERE tenant_id = :T2 AND name = 'SUPER_ADMIN';
INSERT INTO locations(id, tenant_id, organisation_id, name, location_type)
  VALUES ('00000000-0000-0000-0000-00000000d0c1', :T, :O, 'Shop', 'OWN');
INSERT INTO products(id, tenant_id, organisation_id, name, category, hsn_code, unit_of_measure, gst_rate, batch_required)
  VALUES ('00000000-0000-0000-0000-00000000d0d1', :T, :O, 'Neem Urea', 'FERTILIZER', '3102', 'BAG', 5, true);
INSERT INTO farmers(id, tenant_id, organisation_id, first_name, last_name)
  VALUES ('00000000-0000-0000-0000-00000000d0f1', :T, :O, 'Gita', 'Devi');
INSERT INTO chart_of_accounts(tenant_id, organisation_id, account_code, account_name, account_type, account_group)
SELECT :T, :O, c, n, t::account_type_enum, 'g' FROM (VALUES
 ('1001','Cash','ASSET'),('1002','Bank','ASSET'),('1010','Debtors','ASSET'),('1020','Stock','ASSET'),('1040','Subsidy Receivable','ASSET'),
 ('2001','Creditors','LIABILITY'),('2010','CGST Payable','LIABILITY'),('2011','SGST Payable','LIABILITY'),
 ('3001','Sales Fert','INCOME'),('3002','Sales Seeds','INCOME'),('3003','Sales Pest','INCOME'),('4001','COGS Fert','EXPENSE')) v(c,n,t);
INSERT INTO batch_register(id, tenant_id, organisation_id, batch_number, product_id, location_id, opening_qty, current_qty,
   unit_of_measure, purchase_rate, landing_cost_per_unit, status)
VALUES ('00000000-0000-0000-0000-00000000d0b1', :T, :O, 'B-1', '00000000-0000-0000-0000-00000000d0d1',
   '00000000-0000-0000-0000-00000000d0c1', 100, 0, 'BAG', 10, 10, 'OPEN');
INSERT INTO stock_ledger(tenant_id, organisation_id, movement_type, product_id, batch_id, to_location_id, qty, unit_of_measure)
VALUES (:T, :O, 'OPENING', '00000000-0000-0000-0000-00000000d0d1', '00000000-0000-0000-0000-00000000d0b1',
   '00000000-0000-0000-0000-00000000d0c1', 100, 'BAG');

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :U, false);

-- four posted subsidised sales: 10 + 5 + 4 + 2 bags => subsidy 150 + 75 + 60 + 30 = 315
SELECT t_sale('S1', 'POS-S1', 10); SELECT t_sale('S2', 'POS-S2', 5); SELECT t_sale('S3', 'POS-S3', 4); SELECT t_sale('S4', 'POS-S4', 2);
SELECT t_eq('subsidy receivable on the books', t_bal('1040'), 315);

-- 1. CREATE (draft) ------------------------------------------------------------------------
SELECT t_fails('cannot claim "no subsidy"', $$SELECT create_subsidy_claim('00000000-0000-0000-0000-00000000d003', CURRENT_DATE, CURRENT_DATE, 'NONE')$$, 'Choose a subsidy type');
SELECT t_fails('bad period rejected', $$SELECT create_subsidy_claim('00000000-0000-0000-0000-00000000d003', CURRENT_DATE, CURRENT_DATE - 1, 'NEEM_COATED_UREA')$$, 'before period start');
SELECT t_fails('empty period has nothing to claim', $$SELECT create_subsidy_claim('00000000-0000-0000-0000-00000000d003', CURRENT_DATE - 60, CURRENT_DATE - 30, 'NEEM_COATED_UREA')$$, 'No unclaimed');
SELECT t_fails('other subsidy type has nothing to claim', $$SELECT create_subsidy_claim('00000000-0000-0000-0000-00000000d003', CURRENT_DATE, CURRENT_DATE, 'NBS_FERTILIZER')$$, 'No unclaimed');

SELECT create_subsidy_claim('00000000-0000-0000-0000-00000000d003', CURRENT_DATE - 5, CURRENT_DATE, 'NEEM_COATED_UREA', 'Neem urea DBT');
SELECT t_eq('claim A total subsidy', (SELECT total_subsidy_claimed FROM subsidy_claims WHERE claim_status = 'DRAFT'), 315);
SELECT t_eq('claim A total qty', (SELECT total_qty_claimed FROM subsidy_claims WHERE claim_status = 'DRAFT'), 21);
SELECT t_eq('claim A links all four sales', (SELECT sale_count FROM vw_subsidy_claims WHERE claim_status = 'DRAFT'), 4);
SELECT t_eq('claim number is numbered', (SELECT COUNT(*) FROM subsidy_claims WHERE claim_number ~ '^SC-[0-9]{4}-00001$'), 1);
SELECT t_fails('a second claim cannot grab the same sales', $$SELECT create_subsidy_claim('00000000-0000-0000-0000-00000000d003', CURRENT_DATE - 5, CURRENT_DATE, 'NEEM_COATED_UREA')$$, 'No unclaimed');
SELECT t_fails('a sale inside a claim cannot be cancelled', $$SELECT cancel_farmer_sale((SELECT id FROM farmer_sales WHERE sale_number = 'S1'), 'oops')$$, 'part of a subsidy claim');

-- 2. CANCEL a draft frees the sales; recreate => claim B ----------------------------------------
SELECT cancel_subsidy_claim((SELECT id FROM subsidy_claims WHERE claim_status = 'DRAFT'));
SELECT t_eq('cancelled draft frees its sales', (SELECT COUNT(*) FROM farmer_sales WHERE subsidy_claim_id IS NOT NULL), 0);
SELECT create_subsidy_claim('00000000-0000-0000-0000-00000000d003', CURRENT_DATE, CURRENT_DATE, 'NEEM_COATED_UREA');
SELECT t_eq('claim B is number 2', (SELECT COUNT(*) FROM subsidy_claims WHERE claim_status = 'DRAFT' AND claim_number ~ '00002$'), 1);

-- 3. SUBMIT -------------------------------------------------------------------------------
SELECT t_fails('future submission date rejected', $$SELECT submit_subsidy_claim((SELECT id FROM subsidy_claims WHERE claim_status = 'DRAFT'), CURRENT_DATE + 1)$$, 'cannot be in the future');
SELECT t_fails('receipt on a draft claim rejected', $$SELECT record_subsidy_receipt((SELECT id FROM subsidy_claims WHERE claim_status = 'DRAFT'), 10, CURRENT_DATE)$$, 'submitted claim');
SELECT submit_subsidy_claim((SELECT id FROM subsidy_claims WHERE claim_status = 'DRAFT'), CURRENT_DATE, 'GOV/DBT/77');
SELECT t_eq('claim submitted with government ref', (SELECT COUNT(*) FROM subsidy_claims WHERE claim_status = 'SUBMITTED' AND government_ref_no = 'GOV/DBT/77'), 1);
SELECT t_eq('sales became SUBSIDY_CLAIMED', (SELECT COUNT(*) FROM farmer_sales WHERE status = 'SUBSIDY_CLAIMED'), 4);
SELECT t_fails('cannot cancel a draft that was submitted', $$SELECT cancel_subsidy_claim((SELECT id FROM subsidy_claims WHERE claim_status = 'SUBMITTED'))$$, 'Only DRAFT');
SELECT t_fails('claimed sale cannot be cancelled', $$SELECT cancel_farmer_sale((SELECT id FROM farmer_sales WHERE sale_number = 'S2'), 'oops')$$, 'already subsidy claimed');

-- 4. RECEIPTS -----------------------------------------------------------------------------
SELECT t_fails('zero receipt rejected', $$SELECT record_subsidy_receipt((SELECT id FROM subsidy_claims WHERE claim_status = 'SUBMITTED'), 0, CURRENT_DATE)$$, 'must be positive');
SELECT t_fails('over-receipt rejected', $$SELECT record_subsidy_receipt((SELECT id FROM subsidy_claims WHERE claim_status = 'SUBMITTED'), 315.01, CURRENT_DATE)$$, 'exceeds the amount still pending');
SELECT t_fails('future-dated receipt rejected', $$SELECT record_subsidy_receipt((SELECT id FROM subsidy_claims WHERE claim_status = 'SUBMITTED'), 10, CURRENT_DATE + 1)$$, 'cannot be in the future');
SELECT t_fails('receipt into a non-bank account rejected', $$SELECT record_subsidy_receipt((SELECT id FROM subsidy_claims WHERE claim_status = 'SUBMITTED'), 10, CURRENT_DATE,
   (SELECT id FROM chart_of_accounts WHERE account_code = '2001'))$$, 'bank or cash account');
SELECT t_eq('failed receipts changed nothing', t_bal('1040'), 315);

SELECT record_subsidy_receipt((SELECT id FROM subsidy_claims WHERE claim_status = 'SUBMITTED'), 100, CURRENT_DATE, NULL, 'UTR-1001');
SELECT t_eq('partial receipt => PARTIALLY_RECEIVED', (SELECT COUNT(*) FROM subsidy_claims WHERE claim_status = 'PARTIALLY_RECEIVED' AND subsidy_received = 100 AND subsidy_pending = 215), 1);
SELECT t_eq('receivable fell by the receipt', t_bal('1040'), 215);
SELECT t_eq('bank increased', t_bal('1002'), 100);
SELECT t_eq('sales still CLAIMED after a partial receipt', (SELECT COUNT(*) FROM farmer_sales WHERE status = 'SUBSIDY_CLAIMED'), 4);
SELECT t_fails('cannot reject once money was received', $$SELECT reject_subsidy_claim((SELECT id FROM subsidy_claims WHERE claim_status = 'PARTIALLY_RECEIVED'), 'x')$$, 'Only a submitted claim');

SELECT record_subsidy_receipt((SELECT id FROM subsidy_claims WHERE claim_status = 'PARTIALLY_RECEIVED'), 215, CURRENT_DATE, NULL, 'UTR-1002');
SELECT t_eq('final receipt => FULLY_RECEIVED', (SELECT COUNT(*) FROM subsidy_claims WHERE claim_status = 'FULLY_RECEIVED' AND subsidy_pending = 0), 1);
SELECT t_eq('sales became SUBSIDY_RECEIVED', (SELECT COUNT(*) FROM farmer_sales WHERE status = 'SUBSIDY_RECEIVED'), 4);
SELECT t_eq('subsidy receivable cleared', t_bal('1040'), 0);
SELECT t_eq('bank holds the full subsidy', t_bal('1002'), 315);
SELECT t_eq('two receipts recorded', (SELECT COUNT(*) FROM subsidy_receipts), 2);
SELECT t_eq('books balance', (SELECT SUM(period_debit) - SUM(period_credit) FROM vw_trial_balance), 0);
SELECT t_fails('nothing more can be received', $$SELECT record_subsidy_receipt((SELECT id FROM subsidy_claims WHERE claim_status = 'FULLY_RECEIVED'), 1, CURRENT_DATE)$$, 'submitted claim');

-- 5. REJECT + LOCKED PERIOD ----------------------------------------------------------------
SELECT t_sale('S5', 'POS-S5', 3);                                  -- subsidy 45
SELECT create_subsidy_claim('00000000-0000-0000-0000-00000000d003', CURRENT_DATE, CURRENT_DATE, 'NEEM_COATED_UREA');
RESET ROLE;
INSERT INTO period_locks(tenant_id, organisation_id, lock_type, period_from, period_to, is_locked)
VALUES (:T, :O, 'FINANCIAL', date_trunc('month', CURRENT_DATE)::date, (date_trunc('month', CURRENT_DATE) + interval '1 month - 1 day')::date, true);
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :U, false);
SELECT submit_subsidy_claim((SELECT id FROM subsidy_claims WHERE claim_status = 'DRAFT'), CURRENT_DATE, 'GOV/DBT/78');
SELECT t_eq('claiming is allowed in a locked month', (SELECT COUNT(*) FROM farmer_sales WHERE sale_number = 'S5' AND status = 'SUBSIDY_CLAIMED'), 1);
SELECT t_fails('but money cannot be booked into a locked month',
  $$SELECT record_subsidy_receipt((SELECT id FROM subsidy_claims WHERE claim_status = 'SUBMITTED'), 10, CURRENT_DATE)$$, 'locked');
SELECT t_fails('rejection needs a reason', $$SELECT reject_subsidy_claim((SELECT id FROM subsidy_claims WHERE claim_status = 'SUBMITTED'), ' ')$$, 'reason is required');
SELECT reject_subsidy_claim((SELECT id FROM subsidy_claims WHERE claim_status = 'SUBMITTED'), 'Dealer ID mismatch on portal');
SELECT t_eq('rejected claim returns its sale to POSTED, unclaimed', (SELECT COUNT(*) FROM farmer_sales WHERE sale_number = 'S5' AND status = 'POSTED' AND subsidy_claim_id IS NULL), 1);
SELECT t_eq('rejection reason stored', (SELECT COUNT(*) FROM subsidy_claims WHERE claim_status = 'REJECTED' AND rejection_reason LIKE 'Dealer ID%'), 1);
SELECT t_eq('receivable for the rejected sale stays on the books', t_bal('1040'), 45);

-- 6. USERS CANNOT TAMPER -------------------------------------------------------------------
SELECT t_fails('claim totals cannot be edited', $$UPDATE subsidy_claims SET subsidy_received = 999$$, 'permission denied');
SELECT t_fails('claims cannot be inserted by hand', $$INSERT INTO subsidy_claims(tenant_id, organisation_id, claim_number, period_from, period_to, subsidy_type)
   VALUES ('00000000-0000-0000-0000-00000000d001','00000000-0000-0000-0000-00000000d003','SC-X', CURRENT_DATE, CURRENT_DATE, 'NEEM_COATED_UREA')$$, 'permission denied');
SELECT t_fails('receipts cannot be inserted by hand', $$INSERT INTO subsidy_receipts(tenant_id, organisation_id, claim_id, receipt_date, amount, bank_account_id)
   SELECT tenant_id, organisation_id, id, CURRENT_DATE, 1, (SELECT id FROM chart_of_accounts WHERE account_code = '1002') FROM subsidy_claims LIMIT 1$$, 'permission denied');

-- 7. TENANT ISOLATION ----------------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', :U2, false);
SELECT t_eq('other tenant sees no claims', (SELECT COUNT(*) FROM vw_subsidy_claims), 0);
SELECT t_eq('other tenant sees no receipts', (SELECT COUNT(*) FROM subsidy_receipts), 0);
SELECT t_fails('other tenant cannot create a claim in this organisation',
  $$SELECT create_subsidy_claim('00000000-0000-0000-0000-00000000d003', CURRENT_DATE, CURRENT_DATE, 'NEEM_COATED_UREA')$$, 'Organisation not found');
SELECT t_fails('other tenant cannot record a receipt',
  $$SELECT record_subsidy_receipt((SELECT id FROM subsidy_claims LIMIT 1), 1, CURRENT_DATE)$$, 'not found');

RESET ROLE;
DROP FUNCTION public.t_eq(text,numeric,numeric), public.t_fails(text,text,text), public.t_bal(text), public.t_sale(text,text,numeric);
\echo E2E PASSED
