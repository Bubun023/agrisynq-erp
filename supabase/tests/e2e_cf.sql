-- ============================================================
-- C&F custody end-to-end test (requires migrations 001-044)
-- ============================================================
\set ON_ERROR_STOP on
\set T  '''00000000-0000-0000-0000-00000000c001'''
\set U  '''00000000-0000-0000-0000-00000000c002'''
\set O  '''00000000-0000-0000-0000-00000000c003'''
\set T2 '''00000000-0000-0000-0000-00000000c101'''
\set U2 '''00000000-0000-0000-0000-00000000c102'''

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
-- stock at a location (product fixed)
CREATE OR REPLACE FUNCTION public.t_at(loc uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(balance_qty), 0) FROM stock_balance WHERE location_id = loc $$;
CREATE OR REPLACE FUNCTION public.t_bal(code text) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(period_debit - period_credit), 0) FROM vw_trial_balance WHERE account_code = code $$;
-- new draft transfer with one line
CREATE OR REPLACE FUNCTION public.t_xfer(no text, typ text, src uuid, dst uuid, qty numeric, extra_qty numeric DEFAULT NULL) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE id uuid := gen_random_uuid();
BEGIN
  INSERT INTO stock_transfers(id, tenant_id, organisation_id, transfer_no, transfer_type, source_location_id, destination_location_id,
     cnf_withdrawal_req_no)
  VALUES (id, '00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-00000000c003', no, typ::transfer_type_enum, src, dst,
     CASE WHEN typ LIKE 'CNF%' THEN 'REQ-' || no END);
  INSERT INTO stock_transfer_items(tenant_id, transfer_id, product_id, source_batch_id, unit_of_measure, requested_qty)
  VALUES ('00000000-0000-0000-0000-00000000c001', id, '00000000-0000-0000-0000-00000000c0d1', '00000000-0000-0000-0000-00000000c0b1', 'BAG', qty);
  IF extra_qty IS NOT NULL THEN
    INSERT INTO stock_transfer_items(tenant_id, transfer_id, product_id, source_batch_id, unit_of_measure, requested_qty)
    VALUES ('00000000-0000-0000-0000-00000000c001', id, '00000000-0000-0000-0000-00000000c0d1', '00000000-0000-0000-0000-00000000c0b1', 'BAG', extra_qty);
  END IF;
  RETURN id;
END $$;
GRANT EXECUTE ON FUNCTION public.t_eq(text,numeric,numeric), public.t_fails(text,text,text), public.t_at(uuid), public.t_bal(text),
  public.t_xfer(text,text,uuid,uuid,numeric,numeric) TO authenticated;

-- ── setup ──
INSERT INTO tenants(id, slug, name) VALUES (:T, 'cf-1', 'CF One'), (:T2, 'cf-2', 'CF Two');
SELECT onboard_tenant(:T, 'CF One'); SELECT onboard_tenant(:T2, 'CF Two');
INSERT INTO auth.users(id, email) VALUES (:U, 'c1@cf.test'), (:U2, 'c2@cf.test');
INSERT INTO user_profiles(id, tenant_id, full_name) VALUES (:U, :T, 'CF Admin'), (:U2, :T2, 'Other Admin');
INSERT INTO organisations(id, tenant_id, legal_name) VALUES (:O, :T, 'CF Agro');
INSERT INTO user_roles(tenant_id, user_id, role_id, organisation_id)
  SELECT :T, :U, id, :O FROM roles WHERE tenant_id = :T AND name = 'SUPER_ADMIN';
INSERT INTO parties(id, tenant_id, organisation_id, name, party_type)
  VALUES ('00000000-0000-0000-0000-00000000c0a1', :T, :O, 'Sharma C&F Agency', 'CF_AGENT');
INSERT INTO locations(id, tenant_id, organisation_id, name, location_type, custodian_party_id, stock_confirmation_freq_days) VALUES
  ('00000000-0000-0000-0000-00000000c0c1', :T, :O, 'Main Godown', 'OWN', NULL, NULL),
  ('00000000-0000-0000-0000-00000000c0c2', :T, :O, 'Sharma Depot', 'CF_DEPOT', '00000000-0000-0000-0000-00000000c0a1', 30),
  ('00000000-0000-0000-0000-00000000c0c3', :T, :O, 'Unassigned Depot', 'CF_DEPOT', NULL, NULL);
INSERT INTO products(id, tenant_id, organisation_id, name, category, hsn_code, unit_of_measure, gst_rate, batch_required)
  VALUES ('00000000-0000-0000-0000-00000000c0d1', :T, :O, 'DAP 50kg', 'FERTILIZER', '3105', 'BAG', 5, true);
INSERT INTO chart_of_accounts(tenant_id, organisation_id, account_code, account_name, account_type, account_group)
SELECT :T, :O, c, n, t::account_type_enum, 'g' FROM (VALUES
 ('1020','Stock','ASSET'),('4050','Transit Loss','EXPENSE')) v(c,n,t);
INSERT INTO batch_register(id, tenant_id, organisation_id, batch_number, product_id, location_id, opening_qty, current_qty,
   unit_of_measure, purchase_rate, landing_cost_per_unit, status)
VALUES ('00000000-0000-0000-0000-00000000c0b1', :T, :O, 'DAP-1', '00000000-0000-0000-0000-00000000c0d1',
   '00000000-0000-0000-0000-00000000c0c1', 100, 0, 'BAG', 10, 10, 'OPEN');
INSERT INTO stock_ledger(tenant_id, organisation_id, movement_type, product_id, batch_id, to_location_id, qty, unit_of_measure)
VALUES (:T, :O, 'OPENING', '00000000-0000-0000-0000-00000000c0d1', '00000000-0000-0000-0000-00000000c0b1',
   '00000000-0000-0000-0000-00000000c0c1', 100, 'BAG');

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :U, false);

-- 1. SEND 40 BAGS TO THE C&F DEPOT; 1 arrives damaged, 1 is short ------------------------------
SELECT t_xfer('TR-1', 'INTER_BRANCH', '00000000-0000-0000-0000-00000000c0c1', '00000000-0000-0000-0000-00000000c0c2', 40);
SELECT rpc_dispatch_stock_transfer('00000000-0000-0000-0000-00000000c001', (SELECT id FROM stock_transfers WHERE transfer_no = 'TR-1'),
   '00000000-0000-0000-0000-00000000c002');
SELECT t_eq('dispatch: stock leaves the godown', t_at('00000000-0000-0000-0000-00000000c0c1'), 60);
SELECT t_eq('dispatch: in transit (nowhere yet)', t_at('00000000-0000-0000-0000-00000000c0c2'), 0);
SELECT t_eq('dispatch: transfer is IN_TRANSIT', (SELECT (status = 'IN_TRANSIT')::int FROM stock_transfers WHERE transfer_no = 'TR-1'), 1);
SELECT t_eq('dispatch: unit cost taken from the batch', (SELECT unit_cost FROM stock_transfer_items LIMIT 1), 10);

SELECT t_fails('received + damaged cannot exceed dispatched', $$SELECT receive_stock_transfer(
   (SELECT id FROM stock_transfers WHERE transfer_no = 'TR-1'),
   jsonb_build_array(jsonb_build_object('item_id', (SELECT id FROM stock_transfer_items LIMIT 1), 'received', 40, 'damaged', 1)))$$, 'exceeds the dispatched');
SELECT t_fails('negative quantities rejected', $$SELECT receive_stock_transfer(
   (SELECT id FROM stock_transfers WHERE transfer_no = 'TR-1'),
   jsonb_build_array(jsonb_build_object('item_id', (SELECT id FROM stock_transfer_items LIMIT 1), 'received', -1, 'damaged', 0)))$$, 'cannot be negative');
SELECT t_fails('every line needs receipt details', $$SELECT receive_stock_transfer((SELECT id FROM stock_transfers WHERE transfer_no = 'TR-1'), '[]'::jsonb)$$, 'missing');

SELECT receive_stock_transfer((SELECT id FROM stock_transfers WHERE transfer_no = 'TR-1'),
   jsonb_build_array(jsonb_build_object('item_id', (SELECT id FROM stock_transfer_items LIMIT 1), 'received', 38, 'damaged', 1)),
   'One bag burst, one missing');
SELECT t_eq('receipt: depot holds only what arrived intact', t_at('00000000-0000-0000-0000-00000000c0c2'), 38);
SELECT t_eq('receipt: godown unchanged', t_at('00000000-0000-0000-0000-00000000c0c1'), 60);
SELECT t_eq('receipt: batch quantity = total on hand', (SELECT current_qty FROM batch_register WHERE batch_number = 'DAP-1'), 98);
SELECT t_eq('receipt: line shows received 38 / damaged 1 / short 1',
  (SELECT COUNT(*) FROM stock_transfer_items WHERE received_qty = 38 AND damaged_qty = 1 AND shortage_qty = 1), 1);
SELECT t_eq('receipt: loss written off (2 bags x 10)', t_bal('4050'), 20);
SELECT t_eq('receipt: stock account reduced by the loss', t_bal('1020'), -20);
SELECT t_eq('books balance', (SELECT SUM(period_debit) - SUM(period_credit) FROM vw_trial_balance), 0);
SELECT t_fails('cannot receive twice', $$SELECT receive_stock_transfer((SELECT id FROM stock_transfers WHERE transfer_no = 'TR-1'))$$, 'Only IN_TRANSIT');

-- 2. C&F STOCK VIEW + CONFIRMATIONS ---------------------------------------------------------
SELECT t_eq('C&F view shows the depot stock', (SELECT system_qty FROM vw_cf_stock WHERE location_name = 'Sharma Depot'), 38);
SELECT t_eq('C&F view names the agent', (SELECT COUNT(*) FROM vw_cf_stock WHERE cf_agent_name = 'Sharma C&F Agency'), 1);
SELECT t_eq('own godown is not C&F stock', (SELECT COUNT(*) FROM vw_cf_stock WHERE location_name = 'Main Godown'), 0);
SELECT t_eq('never confirmed yet', (SELECT COUNT(*) FROM vw_cf_stock WHERE confirmation_status = 'NEVER_CONFIRMED'), 1);

SELECT t_fails('a depot with no agent cannot be confirmed', $$SELECT record_cf_confirmation('00000000-0000-0000-0000-00000000c0c3',
   '00000000-0000-0000-0000-00000000c0d1', '00000000-0000-0000-0000-00000000c0b1', 0)$$, 'Set the custodian');
SELECT t_fails('a variance needs a remark', $$SELECT record_cf_confirmation('00000000-0000-0000-0000-00000000c0c2',
   '00000000-0000-0000-0000-00000000c0d1', '00000000-0000-0000-0000-00000000c0b1', 36)$$, 'enter a remark');
SELECT t_fails('own godown cannot be confirmed as C&F', $$SELECT record_cf_confirmation('00000000-0000-0000-0000-00000000c0c1',
   '00000000-0000-0000-0000-00000000c0d1', '00000000-0000-0000-0000-00000000c0b1', 60)$$, 'not a C&F');
SELECT t_fails('future confirmation date rejected', $$SELECT record_cf_confirmation('00000000-0000-0000-0000-00000000c0c2',
   '00000000-0000-0000-0000-00000000c0d1', '00000000-0000-0000-0000-00000000c0b1', 38, NULL, NULL, CURRENT_DATE + 1)$$, 'cannot be in the future');

SELECT record_cf_confirmation('00000000-0000-0000-0000-00000000c0c2', '00000000-0000-0000-0000-00000000c0d1',
   '00000000-0000-0000-0000-00000000c0b1', 38, 'CONF-001');
SELECT t_eq('exact count => CONFIRMED', (SELECT COUNT(*) FROM vw_cf_stock WHERE confirmation_status = 'CONFIRMED' AND qty_confirmed = 38), 1);
SELECT t_eq('next confirmation scheduled 30 days out', (SELECT (next_confirmation_due = CURRENT_DATE + 30)::int FROM vw_cf_stock), 1);
SELECT record_cf_confirmation('00000000-0000-0000-0000-00000000c0c2', '00000000-0000-0000-0000-00000000c0d1',
   '00000000-0000-0000-0000-00000000c0b1', 36, 'CONF-002', 'Agent reports 2 bags water damaged');
SELECT t_eq('a short count is flagged as a discrepancy', (SELECT COUNT(*) FROM vw_cf_stock WHERE confirmation_status = 'DISCREPANCY' AND discrepancy_noted AND unconfirmed_difference = 2), 1);
SELECT t_eq('register keeps one row per key', (SELECT COUNT(*) FROM cf_stock_register), 1);
SELECT t_eq('every confirmation is logged', (SELECT COUNT(*) FROM cf_stock_confirmations), 2);
SELECT t_eq('log records the variance', (SELECT variance_qty FROM cf_stock_confirmations ORDER BY created_at DESC LIMIT 1), 2);
SELECT t_fails('register cannot be edited by hand', $$UPDATE cf_stock_register SET qty_confirmed = 38$$, 'permission denied');
SELECT t_fails('confirmation log cannot be deleted', $$DELETE FROM cf_stock_confirmations$$, 'permission denied');
SELECT t_fails('confirmation log cannot be inserted by hand', $$INSERT INTO cf_stock_confirmations(tenant_id, organisation_id, cf_agent_id, location_id, product_id, system_qty, confirmed_qty)
   VALUES ('00000000-0000-0000-0000-00000000c001','00000000-0000-0000-0000-00000000c003','00000000-0000-0000-0000-00000000c0a1','00000000-0000-0000-0000-00000000c0c2','00000000-0000-0000-0000-00000000c0d1',1,1)$$, 'permission denied');

-- 3. WITHDRAWAL FROM THE C&F AGENT (needs company approval) ------------------------------------
SELECT t_xfer('WD-1', 'CNF_TO_OWN_WAREHOUSE', '00000000-0000-0000-0000-00000000c0c2', '00000000-0000-0000-0000-00000000c0c1', 10);
SELECT t_fails('unapproved C&F withdrawal cannot be dispatched', $$SELECT rpc_dispatch_stock_transfer('00000000-0000-0000-0000-00000000c001',
   (SELECT id FROM stock_transfers WHERE transfer_no = 'WD-1'), '00000000-0000-0000-0000-00000000c002')$$, 'must be approved');
SELECT t_fails('approval needs the company reference', $$SELECT approve_stock_transfer((SELECT id FROM stock_transfers WHERE transfer_no = 'WD-1'), ' ')$$, 'company approval reference');
SELECT approve_stock_transfer((SELECT id FROM stock_transfers WHERE transfer_no = 'WD-1'), 'COMP-APR-77');
SELECT t_eq('approved with the reference stored', (SELECT COUNT(*) FROM stock_transfers WHERE transfer_no = 'WD-1' AND status = 'APPROVED' AND cnf_company_approval_ref = 'COMP-APR-77'), 1);
SELECT t_fails('cannot approve twice', $$SELECT approve_stock_transfer((SELECT id FROM stock_transfers WHERE transfer_no = 'WD-1'), 'X')$$, 'Only DRAFT');
SELECT rpc_dispatch_stock_transfer('00000000-0000-0000-0000-00000000c001', (SELECT id FROM stock_transfers WHERE transfer_no = 'WD-1'),
   '00000000-0000-0000-0000-00000000c002');
SELECT t_eq('withdrawal: depot stock falls', t_at('00000000-0000-0000-0000-00000000c0c2'), 28);
SELECT rpc_receive_stock_transfer('00000000-0000-0000-0000-00000000c001', (SELECT id FROM stock_transfers WHERE transfer_no = 'WD-1'),
   '00000000-0000-0000-0000-00000000c002');
SELECT t_eq('withdrawal: godown stock rises', t_at('00000000-0000-0000-0000-00000000c0c1'), 70);
SELECT t_eq('withdrawal: no loss booked on a clean receipt', t_bal('4050'), 20);
SELECT t_eq('withdrawal: batch total unchanged', (SELECT current_qty FROM batch_register WHERE batch_number = 'DAP-1'), 98);
SELECT t_eq('C&F view reflects the withdrawal', (SELECT system_qty FROM vw_cf_stock WHERE location_name = 'Sharma Depot'), 28);

-- 4. OVERSELL ACROSS TWO LINES OF THE SAME BATCH IS CAUGHT ---------------------------------------
SELECT t_xfer('TR-2', 'INTER_BRANCH', '00000000-0000-0000-0000-00000000c0c1', '00000000-0000-0000-0000-00000000c0c2', 40, 40);
SELECT t_fails('two lines of the same batch cannot together exceed stock (70)', $$SELECT rpc_dispatch_stock_transfer('00000000-0000-0000-0000-00000000c001',
   (SELECT id FROM stock_transfers WHERE transfer_no = 'TR-2'), '00000000-0000-0000-0000-00000000c002')$$, 'Insufficient stock');
SELECT t_eq('nothing moved by the failed dispatch', t_at('00000000-0000-0000-0000-00000000c0c1'), 70);

-- 5. DIRECT WRITES CANNOT BYPASS THE ENGINE ----------------------------------------------------
SELECT t_fails('cannot mark a transfer RECEIVED by hand', $$UPDATE stock_transfers SET status = 'RECEIVED' WHERE transfer_no = 'TR-2'$$, 'row-level security');
SELECT t_fails('cannot approve by hand', $$UPDATE stock_transfers SET status = 'APPROVED' WHERE transfer_no = 'TR-2'$$, 'row-level security');
SELECT t_fails('cannot insert an in-transit transfer', $$INSERT INTO stock_transfers(tenant_id, organisation_id, transfer_no, status, source_location_id, destination_location_id)
   VALUES ('00000000-0000-0000-0000-00000000c001','00000000-0000-0000-0000-00000000c003','HACK','IN_TRANSIT',
   '00000000-0000-0000-0000-00000000c0c1','00000000-0000-0000-0000-00000000c0c2')$$, 'row-level security');
SELECT t_fails('cannot pre-fill dispatched quantity on a line', $$INSERT INTO stock_transfer_items(tenant_id, transfer_id, product_id, source_batch_id, unit_of_measure, requested_qty, dispatched_qty)
   SELECT tenant_id, id, '00000000-0000-0000-0000-00000000c0d1', '00000000-0000-0000-0000-00000000c0b1', 'BAG', 5, 5 FROM stock_transfers WHERE transfer_no = 'TR-2'$$, 'row-level security');
UPDATE stock_transfer_items SET requested_qty = 1 WHERE transfer_id = (SELECT id FROM stock_transfers WHERE transfer_no = 'WD-1');   -- RLS hides finished transfers: 0 rows
SELECT t_eq('lines of a finished transfer are frozen', (SELECT requested_qty FROM stock_transfer_items WHERE transfer_id = (SELECT id FROM stock_transfers WHERE transfer_no = 'WD-1')), 10);

-- 6. TENANT ISOLATION ---------------------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', :U2, false);
SELECT t_eq('other tenant sees no C&F stock', (SELECT COUNT(*) FROM vw_cf_stock), 0);
SELECT t_eq('other tenant sees no confirmations', (SELECT COUNT(*) FROM cf_stock_confirmations), 0);
SELECT t_fails('other tenant cannot dispatch our transfer (spoofing our ids)', $$SELECT rpc_dispatch_stock_transfer('00000000-0000-0000-0000-00000000c001',
   (SELECT id FROM stock_transfers LIMIT 1), '00000000-0000-0000-0000-00000000c002')$$, 'Forbidden');
SELECT t_fails('other tenant cannot approve ours', $$SELECT approve_stock_transfer('00000000-0000-0000-0000-00000000c001', 'x')$$, 'not found');
SELECT t_fails('other tenant cannot confirm our depot', $$SELECT record_cf_confirmation('00000000-0000-0000-0000-00000000c0c2',
   '00000000-0000-0000-0000-00000000c0d1', '00000000-0000-0000-0000-00000000c0b1', 1)$$, 'Location not found');

RESET ROLE;
DROP FUNCTION public.t_eq(text,numeric,numeric), public.t_fails(text,text,text), public.t_at(uuid), public.t_bal(text),
  public.t_xfer(text,text,uuid,uuid,numeric,numeric);
\echo E2E PASSED
