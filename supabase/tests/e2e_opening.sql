-- ============================================================
-- Opening balances end-to-end test (requires migrations 001-051)
-- ============================================================
\set ON_ERROR_STOP on
\set Ou 00000000-0000-0000-0000-000000009003
\set P1u 00000000-0000-0000-0000-0000000090a1
\set P2u 00000000-0000-0000-0000-0000000090a2
\set L1u 00000000-0000-0000-0000-0000000090b1
\set C1u 00000000-0000-0000-0000-0000000090e1
\set C2u 00000000-0000-0000-0000-0000000090e2
\set S1u 00000000-0000-0000-0000-0000000090e3
\set T  '''00000000-0000-0000-0000-000000009001'''
\set U  '''00000000-0000-0000-0000-000000009002'''
\set UA '''00000000-0000-0000-0000-000000009004'''
\set UV '''00000000-0000-0000-0000-000000009005'''
\set O  '''00000000-0000-0000-0000-000000009003'''
\set T2 '''00000000-0000-0000-0000-000000009101'''
\set U2 '''00000000-0000-0000-0000-000000009102'''
\set O2 '''00000000-0000-0000-0000-000000009103'''
\set P1 '''00000000-0000-0000-0000-0000000090a1'''
\set P2 '''00000000-0000-0000-0000-0000000090a2'''
\set L1 '''00000000-0000-0000-0000-0000000090b1'''
\set C1 '''00000000-0000-0000-0000-0000000090e1'''
\set C2 '''00000000-0000-0000-0000-0000000090e2'''
\set S1 '''00000000-0000-0000-0000-0000000090e3'''

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
-- debit - credit on an account code
CREATE OR REPLACE FUNCTION public.t_dr(code text) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(period_debit - period_credit), 0) FROM vw_trial_balance WHERE account_code = code $$;
GRANT EXECUTE ON FUNCTION public.t_eq(text,numeric,numeric), public.t_fails(text,text,text), public.t_dr(text) TO authenticated;

-- ── setup ──
INSERT INTO tenants(id, slug, name) VALUES (:T, 'open-1', 'Open One'), (:T2, 'open-2', 'Open Two');
SELECT onboard_tenant(:T, 'Open One'); SELECT onboard_tenant(:T2, 'Open Two');
INSERT INTO auth.users(id, email) VALUES (:U, 'o1@open.test'), (:UA, 'oa@open.test'), (:UV, 'ov@open.test'), (:U2, 'o2@open.test');
INSERT INTO user_profiles(id, tenant_id, full_name) VALUES (:U, :T, 'Open Admin'), (:UA, :T, 'Open Accountant'), (:UV, :T, 'Open Viewer'), (:U2, :T2, 'Other Admin');
INSERT INTO organisations(id, tenant_id, legal_name) VALUES (:O, :T, 'Open Agro'), (:O2, :T2, 'Other Agro');
INSERT INTO user_roles(tenant_id, user_id, role_id, organisation_id) SELECT :T, :U, id, :O FROM roles WHERE tenant_id = :T AND name = 'SUPER_ADMIN';
INSERT INTO user_roles(tenant_id, user_id, role_id, organisation_id) SELECT :T, :UA, id, :O FROM roles WHERE tenant_id = :T AND name = 'ACCOUNTANT';
INSERT INTO user_roles(tenant_id, user_id, role_id, organisation_id) SELECT :T, :UV, id, :O FROM roles WHERE tenant_id = :T AND name = 'VIEWER';
INSERT INTO user_roles(tenant_id, user_id, role_id, organisation_id) SELECT :T2, :U2, id, :O2 FROM roles WHERE tenant_id = :T2 AND name = 'SUPER_ADMIN';
INSERT INTO locations(id, tenant_id, organisation_id, name, location_type) VALUES (:L1, :T, :O, 'Main Godown', 'OWN');
INSERT INTO products(id, tenant_id, organisation_id, name, category, hsn_code, unit_of_measure, gst_rate, batch_required) VALUES
  (:P1, :T, :O, 'Urea', 'FERTILIZER', '3102', 'BAG', 5, true), (:P2, :T, :O, 'DAP', 'FERTILIZER', '3105', 'BAG', 5, true);
INSERT INTO parties(id, tenant_id, organisation_id, name, party_type) VALUES
  (:C1, :T, :O, 'Customer One', 'CUSTOMER'), (:C2, :T, :O, 'Customer Two', 'CUSTOMER'), (:S1, :T, :O, 'Supplier One', 'SUPPLIER');
INSERT INTO chart_of_accounts(tenant_id, organisation_id, account_code, account_name, account_type, account_group)
SELECT :T, :O, c, n, t::account_type_enum, 'g' FROM (VALUES
 ('1001','Cash','ASSET'),('1002','Bank','ASSET'),('1010','Debtors','ASSET'),('1020','Stock','ASSET'),
 ('2001','Creditors','LIABILITY'),('2100','Capital Account','EQUITY')) v(c,n,t);

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :U, false);

-- 1. rejections: nothing is half-posted ---------------------------------------------------------
SELECT t_fails('zero quantity refused', format($$SELECT post_opening_balances(%L, NULL, CURRENT_DATE, '[{"product_id":"%s","location_id":"%s","batch_number":"X","qty":0,"rate":1}]')$$, :'Ou', :'P1u', :'L1u')::text, 'quantity must be greater');
SELECT t_fails('batch number required', format($$SELECT post_opening_balances(%L, NULL, CURRENT_DATE, '[{"product_id":"%s","location_id":"%s","batch_number":" ","qty":1,"rate":1}]')$$, :'Ou', :'P1u', :'L1u')::text, 'batch number is required');
SELECT t_fails('controlled account refused', format($$SELECT post_opening_balances(%L, NULL, CURRENT_DATE, '[]', '[]', '[{"account_code":"1010","debit":5}]')$$, :'Ou')::text, 'controlled');
SELECT t_fails('debit and credit together refused', format($$SELECT post_opening_balances(%L, NULL, CURRENT_DATE, '[]', '[]', '[{"account_code":"1001","debit":5,"credit":5}]')$$, :'Ou')::text, 'either a debit or a credit');
SELECT t_fails('unknown account refused', format($$SELECT post_opening_balances(%L, NULL, CURRENT_DATE, '[]', '[]', '[{"account_code":"9999","debit":5}]')$$, :'Ou')::text, 'not found');
SELECT t_fails('nothing to import', format($$SELECT post_opening_balances(%L, NULL, CURRENT_DATE)$$, :'Ou')::text, 'Nothing to import');
SELECT t_eq('a failed import leaves no batch behind', (SELECT COUNT(*) FROM batch_register), 0);
SELECT t_eq('a failed import leaves no voucher behind', (SELECT COUNT(*) FROM journal_vouchers), 0);

-- 2. the real thing -------------------------------------------------------------------------------
-- stock 100 x 240 + 50 x 1200 = 84,000; customers owe 45,000 and hold a 2,000 advance; we owe a supplier 30,000;
-- cash 25,000 and bank 10,000. Net assets = 84000 + 43000 + 35000 - 30000 = 132,000 -> capital.
SELECT post_opening_balances(:O, NULL, CURRENT_DATE - 30,
  format('[{"product_id":"%s","location_id":"%s","batch_number":"U-01","qty":100,"rate":240,"expiry_date":"2027-01-31"},
          {"product_id":"%s","location_id":"%s","batch_number":"D-01","qty":50,"rate":1200}]', :'P1u', :'L1u', :'P2u', :'L1u')::jsonb,
  format('[{"party_id":"%s","amount":45000},{"party_id":"%s","amount":-2000},{"party_id":"%s","amount":30000}]', :'C1u', :'C2u', :'S1u')::jsonb,
  '[{"account_code":"1001","debit":25000},{"account_code":"1002","debit":10000}]');

SELECT t_eq('stock in hand', t_dr('1020'), 84000);
SELECT t_eq('debtors = 45000 owed less 2000 advance', t_dr('1010'), 43000);
SELECT t_eq('creditors = 30000', -t_dr('2001'), 30000);
SELECT t_eq('cash', t_dr('1001'), 25000);
SELECT t_eq('capital takes the balance', -t_dr('2100'), 132000);
SELECT t_eq('whole books balance', (SELECT SUM(period_debit - period_credit) FROM vw_trial_balance), 0);
SELECT t_eq('stock units in the ledger', (SELECT SUM(balance_qty) FROM stock_balance), 150);
SELECT t_eq('batch carries its cost', (SELECT landing_cost_per_unit FROM batch_register WHERE batch_number = 'D-01'), 1200);
SELECT t_eq('batch current_qty maintained by the trigger', (SELECT current_qty FROM batch_register WHERE batch_number = 'U-01'), 100);
SELECT t_eq('stock sub-ledger value ties to account 1020',
  (SELECT SUM(sb.balance_qty * b.landing_cost_per_unit) FROM stock_balance sb JOIN batch_register b ON b.id = sb.batch_id), t_dr('1020'));
SELECT t_eq('party ledger: customer one owes 45000',
  (SELECT SUM(l.debit_amount - l.credit_amount) FROM journal_voucher_lines l WHERE l.party_id = :C1::uuid), 45000);
SELECT t_eq('the voucher is dated on the opening date and is POSTED',
  (SELECT COUNT(*) FROM journal_vouchers WHERE reference_type = 'OPENING_BALANCE' AND status = 'POSTED' AND voucher_date = CURRENT_DATE - 30), 1);

-- 3. only once for parties / accounts; stock can be topped up --------------------------------------
SELECT t_fails('a party cannot be opened twice', format($$SELECT post_opening_balances(%L, NULL, CURRENT_DATE, '[]', '[{"party_id":"%s","amount":5}]')$$, :'Ou', :'C1u')::text, 'already has an opening balance');
SELECT t_fails('an account cannot be opened twice', format($$SELECT post_opening_balances(%L, NULL, CURRENT_DATE, '[]', '[]', '[{"account_code":"1001","debit":1}]')$$, :'Ou')::text, 'already has an opening balance');
SELECT t_fails('the same batch cannot be loaded twice', format($$SELECT post_opening_balances(%L, NULL, CURRENT_DATE, '[{"product_id":"%s","location_id":"%s","batch_number":"U-01","qty":1,"rate":1}]')$$, :'Ou', :'P1u', :'L1u')::text, 'already exists');
SELECT post_opening_balances(:O, NULL, CURRENT_DATE - 30, format('[{"product_id":"%s","location_id":"%s","batch_number":"U-02","qty":10,"rate":250}]', :'P1u', :'L1u')::jsonb);
SELECT t_eq('more stock can be added in a later run', t_dr('1020'), 86500);
SELECT t_eq('and the books still balance', (SELECT SUM(period_debit - period_credit) FROM vw_trial_balance), 0);

-- 4. who may post, and tenant isolation ------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', :UV, false);
SELECT t_fails('a viewer cannot post opening balances', format($$SELECT post_opening_balances(%L, NULL, CURRENT_DATE, '[]', '[]', '[{"account_code":"1002","debit":1}]')$$, :'Ou')::text, 'Only an admin or accountant');
SELECT set_config('request.jwt.claim.sub', :U2, false);
SELECT t_fails('another company cannot post into our organisation', format($$SELECT post_opening_balances(%L, NULL, CURRENT_DATE, '[]', '[]', '[{"account_code":"1002","debit":1}]')$$, :'Ou')::text, 'Organisation not found');
SELECT set_config('request.jwt.claim.sub', :UA, false);
SELECT t_fails('accountant: duplicate refused, proving the call is allowed through', format($$SELECT post_opening_balances(%L, NULL, CURRENT_DATE, '[]', '[]', '[{"account_code":"1002","debit":1}]')$$, :'Ou')::text, 'already has an opening balance');

RESET ROLE;
DROP FUNCTION public.t_eq(text,numeric,numeric), public.t_fails(text,text,text), public.t_dr(text);
\echo E2E PASSED
