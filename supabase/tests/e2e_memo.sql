-- ============================================================
-- Memo purchase / invoice matching / stock journal end-to-end test (requires migrations 001-047)
-- Story: co-distributor X physically supplies product A on a challan, then bills product B.
-- ============================================================
\set ON_ERROR_STOP on
\set T  '''00000000-0000-0000-0000-00000000b001'''
\set U  '''00000000-0000-0000-0000-00000000b002'''
\set UV '''00000000-0000-0000-0000-00000000b004'''
\set O  '''00000000-0000-0000-0000-00000000b003'''
\set T2 '''00000000-0000-0000-0000-00000000b101'''
\set U2 '''00000000-0000-0000-0000-00000000b102'''

CREATE OR REPLACE FUNCTION public.t_eq(label text, got numeric, want numeric) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
  IF got IS DISTINCT FROM want THEN RAISE EXCEPTION 'FAIL [%]: got %, want %', label, got, want; END IF;
  RAISE NOTICE 'ok   %  = %', label, got;
END $$;
CREATE OR REPLACE FUNCTION public.t_near(label text, got numeric, want numeric, tol numeric) RETURNS void
LANGUAGE plpgsql AS $$ BEGIN
  IF got IS NULL OR abs(got - want) > tol THEN RAISE EXCEPTION 'FAIL [%]: got %, want % (+/- %)', label, got, want, tol; END IF;
  RAISE NOTICE 'ok   %  = % (want %)', label, got, want;
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
-- credit - debit on an account / debit - credit
CREATE OR REPLACE FUNCTION public.t_dr(code text) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(period_debit - period_credit), 0) FROM vw_trial_balance WHERE account_code = code $$;
CREATE OR REPLACE FUNCTION public.t_jv(ref uuid, code text, side text) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(CASE WHEN side = 'dr' THEN l.debit_amount ELSE l.credit_amount END), 0)
    FROM journal_voucher_lines l JOIN journal_vouchers v ON v.id = l.voucher_id JOIN chart_of_accounts a ON a.id = l.account_id
   WHERE v.reference_id = ref AND a.account_code = code $$;
CREATE OR REPLACE FUNCTION public.t_stock(prod uuid) RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(balance_qty), 0) FROM stock_balance WHERE product_id = prod $$;
-- stock sub-ledger value: units x batch cost, over every batch
CREATE OR REPLACE FUNCTION public.t_stock_value() RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE(SUM(sb.balance_qty * COALESCE(b.landing_cost_per_unit, b.purchase_rate, 0)), 0)
    FROM stock_balance sb JOIN batch_register b ON b.id = sb.batch_id $$;
-- a posted supplier invoice for one product
CREATE OR REPLACE FUNCTION public.t_pi(no text, supp uuid, prod uuid, qty numeric, rate numeric, gst numeric DEFAULT 5, do_post boolean DEFAULT true) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE id uuid := gen_random_uuid(); tx numeric := qty * rate; g numeric := round(qty * rate * gst / 200, 2);
BEGIN
  INSERT INTO purchase_invoices(id, tenant_id, organisation_id, invoice_number, invoice_date, supplier_id, received_at_location,
     gross_amount, taxable_amount, cgst_amount, sgst_amount, net_payable, status)
  VALUES (id, '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000000b003', no, CURRENT_DATE, supp,
     '00000000-0000-0000-0000-00000000b0c1', tx, tx, g, g, tx + 2 * g, 'DRAFT');
  INSERT INTO purchase_invoice_lines(invoice_id, tenant_id, line_no, product_id, hsn_code, received_qty, unit_of_measure, unit_price,
     taxable_amount, gst_rate, cgst_amount, sgst_amount, line_total)
  VALUES (id, '00000000-0000-0000-0000-00000000b001', 1, prod, '3102', qty, 'BAG', rate, tx, gst, g, g, tx + 2 * g);
  IF do_post THEN PERFORM post_purchase_invoice(id); END IF;
  RETURN id;
END $$;
-- a posted credit sale of qty from a batch at price (5% GST), used to move stock out WITH accounting
CREATE OR REPLACE FUNCTION public.t_sale(no text, bat uuid, prod uuid, qty numeric, price numeric) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE id uuid := gen_random_uuid(); tx numeric := qty * price; g numeric := round(qty * price * 0.025, 2);
BEGIN
  INSERT INTO sales_invoices(id, tenant_id, organisation_id, invoice_number, invoice_date, sale_type, customer_id, from_location,
     gross_amount, taxable_amount, cgst_amount, sgst_amount, net_receivable, status)
  VALUES (id, '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-00000000b003', no, CURRENT_DATE, 'CREDIT',
     '00000000-0000-0000-0000-00000000b0e2', '00000000-0000-0000-0000-00000000b0c1', tx, tx, g, g, tx + 2 * g, 'DRAFT');
  INSERT INTO sales_invoice_lines(invoice_id, tenant_id, line_no, product_id, hsn_code, batch_id, qty, unit_of_measure, unit_price,
     taxable_amount, gst_rate, cgst_amount, sgst_amount, line_total)
  VALUES (id, '00000000-0000-0000-0000-00000000b001', 1, prod, '3102', bat, qty, 'BAG', price, tx, 5, g, g, tx + 2 * g);
  PERFORM post_sales_invoice(id);
  RETURN id;
END $$;
GRANT EXECUTE ON FUNCTION public.t_eq(text,numeric,numeric), public.t_near(text,numeric,numeric,numeric), public.t_fails(text,text,text),
  public.t_dr(text), public.t_jv(uuid,text,text), public.t_stock(uuid), public.t_stock_value(),
  public.t_pi(text,uuid,uuid,numeric,numeric,numeric,boolean), public.t_sale(text,uuid,uuid,numeric,numeric) TO authenticated;

-- ── setup ──
INSERT INTO tenants(id, slug, name) VALUES (:T, 'memo-1', 'Memo One'), (:T2, 'memo-2', 'Memo Two');
SELECT onboard_tenant(:T, 'Memo One'); SELECT onboard_tenant(:T2, 'Memo Two');
INSERT INTO auth.users(id, email) VALUES (:U, 'm1@memo.test'), (:UV, 'mv@memo.test'), (:U2, 'm2@memo.test');
INSERT INTO user_profiles(id, tenant_id, full_name) VALUES (:U, :T, 'Memo Admin'), (:UV, :T, 'Memo Viewer'), (:U2, :T2, 'Other Admin');
INSERT INTO organisations(id, tenant_id, legal_name) VALUES (:O, :T, 'Memo Agro');
INSERT INTO user_roles(tenant_id, user_id, role_id, organisation_id)
  SELECT :T, :U, id, :O FROM roles WHERE tenant_id = :T AND name = 'SUPER_ADMIN';
-- the OTHER company's user is a real admin of their own company, so cross-tenant checks are what stops them (not a missing role)
INSERT INTO user_roles(tenant_id, user_id, role_id)
  SELECT :T2, :U2, id FROM roles WHERE tenant_id = :T2 AND name = 'SUPER_ADMIN';
INSERT INTO user_roles(tenant_id, user_id, role_id, organisation_id)
  SELECT :T, :UV, id, :O FROM roles WHERE tenant_id = :T AND name = 'VIEWER';
INSERT INTO locations(id, tenant_id, organisation_id, name, location_type)
  VALUES ('00000000-0000-0000-0000-00000000b0c1', :T, :O, 'Main Godown', 'OWN');
INSERT INTO products(id, tenant_id, organisation_id, name, category, hsn_code, unit_of_measure, gst_rate, batch_required) VALUES
  ('00000000-0000-0000-0000-00000000b0a1', :T, :O, 'Product A', 'FERTILIZER', '3102', 'BAG', 5, true),
  ('00000000-0000-0000-0000-00000000b0b1', :T, :O, 'Product B', 'FERTILIZER', '3102', 'BAG', 5, true);
INSERT INTO parties(id, tenant_id, organisation_id, name, party_type) VALUES
  ('00000000-0000-0000-0000-00000000b0e1', :T, :O, 'Co-distributor X', 'SUPPLIER'),
  ('00000000-0000-0000-0000-00000000b0e3', :T, :O, 'Other Supplier Z', 'SUPPLIER'),
  ('00000000-0000-0000-0000-00000000b0e2', :T, :O, 'Customer Y', 'CUSTOMER');
INSERT INTO chart_of_accounts(tenant_id, organisation_id, account_code, account_name, account_type, account_group)
SELECT :T, :O, c, n, t::account_type_enum, 'g' FROM (VALUES
 ('1001','Cash','ASSET'),('1010','Debtors','ASSET'),('1020','Stock','ASSET'),
 ('2001','Creditors','LIABILITY'),('2005','Goods Received - Invoice Pending','LIABILITY'),
 ('2010','CGST Payable','LIABILITY'),('2011','SGST Payable','LIABILITY'),('2012','IGST Payable','LIABILITY'),
 ('3001','Sales Fert','INCOME'),('3002','Sales Seeds','INCOME'),('3003','Sales Pest','INCOME'),('3020','Other Income','INCOME'),
 ('4001','COGS Fert','EXPENSE'),('4002','COGS Seeds','EXPENSE'),('4003','COGS Pest','EXPENSE'),
 ('4040','ITC CGST','ASSET'),('4041','ITC SGST','ASSET'),('4042','ITC IGST','ASSET')) v(c,n,t);

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :U, false);

-- 1. MEMO PURCHASE ------------------------------------------------------------------------------
-- challan CH-77: 100 x A @10 with 2% discount; 10 + 5 free x A @10 with a flat Rs 5 discount
SELECT t_fails('a memo needs the supplier challan/reference', $$INSERT INTO memo_purchases(tenant_id, organisation_id, memo_no, supplier_id, received_at_location, supplier_ref)
   VALUES ('00000000-0000-0000-0000-00000000b001','00000000-0000-0000-0000-00000000b003','M-X','00000000-0000-0000-0000-00000000b0e1','00000000-0000-0000-0000-00000000b0c1','  ')$$, 'supplier_ref');
INSERT INTO memo_purchases(id, tenant_id, organisation_id, memo_no, memo_date, supplier_id, received_at_location, supplier_ref, narration)
VALUES ('00000000-0000-0000-0000-00000000b5a1', :T, :O, 'MEMO-1', CURRENT_DATE, '00000000-0000-0000-0000-00000000b0e1',
        '00000000-0000-0000-0000-00000000b0c1', 'CH-77', 'X delivered A on challan');
INSERT INTO memo_purchase_lines(id, tenant_id, memo_id, line_no, product_id, qty, free_qty, unit_of_measure, rate, discount_percent, discount_amount, batch_number) VALUES
  ('00000000-0000-0000-0000-00000000b6a1', :T, '00000000-0000-0000-0000-00000000b5a1', 1, '00000000-0000-0000-0000-00000000b0a1', 100, 0, 'BAG', 10, 2, 0, NULL),
  ('00000000-0000-0000-0000-00000000b6a2', :T, '00000000-0000-0000-0000-00000000b5a1', 2, '00000000-0000-0000-0000-00000000b0a1', 10, 5, 'BAG', 10, 0, 5, 'MEMO-B2');

SELECT t_fails('viewer cannot post a memo', $$SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000b004', false), post_memo_purchase('00000000-0000-0000-0000-00000000b5a1')$$, 'Only an admin');
SELECT set_config('request.jwt.claim.sub', :U, false);
SELECT t_fails('users cannot write a net amount themselves', $$UPDATE memo_purchase_lines SET net_amount = 1 WHERE line_no = 1$$, 'row-level security');
SELECT post_memo_purchase('00000000-0000-0000-0000-00000000b5a1');

SELECT t_eq('memo posted', (SELECT (status = 'POSTED')::int FROM memo_purchases WHERE memo_no = 'MEMO-1'), 1);
SELECT t_eq('line 1 cost = 10 less 2% = 9.80', (SELECT unit_cost FROM memo_purchase_lines WHERE line_no = 1), 9.8);
SELECT t_eq('line 1 net 980', (SELECT net_amount FROM memo_purchase_lines WHERE line_no = 1), 980);
SELECT t_eq('line 2 net = 100 less flat 5 = 95', (SELECT net_amount FROM memo_purchase_lines WHERE line_no = 2), 95);
SELECT t_eq('line 2 cost spreads over paid + free units (95/15)', (SELECT unit_cost FROM memo_purchase_lines WHERE line_no = 2), 6.3333);
SELECT t_eq('memo total value', (SELECT total_value FROM memo_purchases WHERE memo_no = 'MEMO-1'), 1075);
SELECT t_eq('stock of A received', t_stock('00000000-0000-0000-0000-00000000b0a1'), 115);
SELECT t_eq('memo goods start in their own batches (explicit name kept)', (SELECT COUNT(*) FROM batch_register WHERE batch_number IN ('MEMO-1-L1', 'MEMO-B2')), 2);
SELECT t_eq('journal DR stock', t_jv('00000000-0000-0000-0000-00000000b5a1', '1020', 'dr'), 1075);
SELECT t_eq('journal CR goods-received-invoice-pending', t_jv('00000000-0000-0000-0000-00000000b5a1', '2005', 'cr'), 1075);
SELECT t_eq('no GST and no input credit on a memo', t_dr('4040') + t_dr('4041') + t_dr('4042'), 0);
SELECT t_fails('cannot post twice', $$SELECT post_memo_purchase('00000000-0000-0000-0000-00000000b5a1')$$, 'Only DRAFT');

SELECT t_eq('both lines pending an invoice', (SELECT COUNT(*) FROM vw_memo_pending WHERE memo_no = 'MEMO-1'), 2);
SELECT t_eq('pending by supplier: value', (SELECT pending_value FROM vw_memo_pending_by_supplier WHERE supplier_name = 'Co-distributor X'), 1075);
SELECT t_eq('pending by supplier: open memos', (SELECT open_memos FROM vw_memo_pending_by_supplier WHERE supplier_name = 'Co-distributor X'), 1);

-- 2. 5 UNITS OF THE MEMO STOCK ARE SOLD BEFORE THE INVOICE ARRIVES -------------------------------------
SELECT t_sale('SI-1', (SELECT batch_id FROM memo_purchase_lines WHERE line_no = 2), '00000000-0000-0000-0000-00000000b0a1', 5, 20);
SELECT t_near('COGS of the sale at memo cost (5 x 6.3333)', t_dr('4001'), 31.67, 0.01);

-- 3. X'S INVOICE ARRIVES, BILLED AS PRODUCT B ----------------------------------------------------------
SELECT t_pi('PI-901', '00000000-0000-0000-0000-00000000b0e1', '00000000-0000-0000-0000-00000000b0b1', 100, 10);
SELECT t_pi('PI-902', '00000000-0000-0000-0000-00000000b0e1', '00000000-0000-0000-0000-00000000b0b1', 15, 8);
SELECT t_eq('B stock arrived from both invoices', t_stock('00000000-0000-0000-0000-00000000b0b1'), 115);

SELECT t_fails('viewer cannot match', $$SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000b004', false),
   settle_memo_with_invoice('00000000-0000-0000-0000-00000000b5a1', (SELECT id FROM purchase_invoices WHERE invoice_number = 'PI-901'),
   jsonb_build_array(jsonb_build_object('memo_line_id','00000000-0000-0000-0000-00000000b6a1','invoice_line_id',(SELECT id FROM purchase_invoice_lines WHERE invoice_id = (SELECT id FROM purchase_invoices WHERE invoice_number = 'PI-901')),'units',100)))$$, 'Only an admin');
SELECT set_config('request.jwt.claim.sub', :U, false);
-- the supplier's other invoice, a draft, and an invoice from another supplier
SELECT t_pi('PI-DRAFT', '00000000-0000-0000-0000-00000000b0e1', '00000000-0000-0000-0000-00000000b0b1', 5, 10, 5, false);
SELECT t_pi('PI-Z1', '00000000-0000-0000-0000-00000000b0e3', '00000000-0000-0000-0000-00000000b0b1', 5, 10);

SELECT t_fails('draft invoice cannot be matched', $$SELECT settle_memo_with_invoice('00000000-0000-0000-0000-00000000b5a1', (SELECT id FROM purchase_invoices WHERE invoice_number = 'PI-DRAFT'),
   jsonb_build_array(jsonb_build_object('memo_line_id','00000000-0000-0000-0000-00000000b6a1','invoice_line_id',(SELECT id FROM purchase_invoice_lines WHERE invoice_id = (SELECT id FROM purchase_invoices WHERE invoice_number = 'PI-DRAFT')),'units',1)))$$, 'must be posted first');
SELECT t_fails('another supplier''s invoice cannot be matched', $$SELECT settle_memo_with_invoice('00000000-0000-0000-0000-00000000b5a1', (SELECT id FROM purchase_invoices WHERE invoice_number = 'PI-Z1'),
   jsonb_build_array(jsonb_build_object('memo_line_id','00000000-0000-0000-0000-00000000b6a1','invoice_line_id',(SELECT id FROM purchase_invoice_lines WHERE invoice_id = (SELECT id FROM purchase_invoices WHERE invoice_number = 'PI-Z1')),'units',1)))$$, 'different supplier');
SELECT t_fails('cannot match more than is pending', $$SELECT settle_memo_with_invoice('00000000-0000-0000-0000-00000000b5a1', (SELECT id FROM purchase_invoices WHERE invoice_number = 'PI-901'),
   jsonb_build_array(jsonb_build_object('memo_line_id','00000000-0000-0000-0000-00000000b6a1','invoice_line_id',(SELECT id FROM purchase_invoice_lines WHERE invoice_id = (SELECT id FROM purchase_invoices WHERE invoice_number = 'PI-901')),'units',101)))$$, 'still pending');
SELECT t_eq('failed attempts changed nothing', t_dr('2005') * -1, 1075);

-- 3a. memo line 1 (100 x A, all on hand) against PI-901 line (100 x B)
SELECT settle_memo_with_invoice('00000000-0000-0000-0000-00000000b5a1', (SELECT id FROM purchase_invoices WHERE invoice_number = 'PI-901'),
   jsonb_build_array(jsonb_build_object('memo_line_id','00000000-0000-0000-0000-00000000b6a1',
                                        'invoice_line_id',(SELECT id FROM purchase_invoice_lines WHERE invoice_id = (SELECT id FROM purchase_invoices WHERE invoice_number = 'PI-901')),
                                        'units',100)), 'X billed A as B');
SELECT t_eq('settlement: all 100 units were on hand', (SELECT units_on_hand FROM memo_settlement_lines ORDER BY units DESC LIMIT 1), 100);
SELECT t_eq('settlement: none sold', (SELECT units_sold FROM memo_settlement_lines ORDER BY units DESC LIMIT 1), 0);
SELECT t_eq('settlement clears the pending liability at memo cost',
  t_jv((SELECT id FROM memo_settlements ORDER BY created_at LIMIT 1), '2005', 'dr'), 980);
SELECT t_eq('settlement takes the memo stock back out at memo cost',
  t_jv((SELECT id FROM memo_settlements ORDER BY created_at LIMIT 1), '1020', 'cr'), 980);
SELECT t_eq('memo line 1 fully settled', (SELECT pending_units FROM memo_purchase_lines WHERE line_no = 1), 0);
SELECT t_eq('A stock now = line 2 only (15 - 5 sold)', t_stock('00000000-0000-0000-0000-00000000b0a1'), 10);
SELECT t_eq('pending liability left = line 2 (95)', t_dr('2005') * -1, 95);
SELECT t_fails('the same invoice line cannot be over-used', $$SELECT settle_memo_with_invoice('00000000-0000-0000-0000-00000000b5a1', (SELECT id FROM purchase_invoices WHERE invoice_number = 'PI-901'),
   jsonb_build_array(jsonb_build_object('memo_line_id','00000000-0000-0000-0000-00000000b6a2','invoice_line_id',(SELECT id FROM purchase_invoice_lines WHERE invoice_id = (SELECT id FROM purchase_invoices WHERE invoice_number = 'PI-901')),'units',1)))$$, 'not yet matched');

-- STOCK JOURNAL: physically A, billed B -> stock out B, stock in A (value carried: 100 x 10 = 1000)
SELECT t_near('books before the journal: stock account (1075 - 31.67 + 1000 + 120 + 50 - 980)', t_dr('1020'), 1233.33, 0.01);
SELECT t_fails('journal needs a reason', $$SELECT post_stock_journal('00000000-0000-0000-0000-00000000b003', CURRENT_DATE, '00000000-0000-0000-0000-00000000b0c1', ' ',
   jsonb_build_array(jsonb_build_object('batch_id', (SELECT batch_id FROM purchase_invoice_lines WHERE invoice_id = (SELECT id FROM purchase_invoices WHERE invoice_number = 'PI-901')), 'qty', 100)),
   jsonb_build_array(jsonb_build_object('product_id','00000000-0000-0000-0000-00000000b0a1','qty',100)))$$, 'reason is required');
SELECT t_fails('journal cannot send out more than is on hand', $$SELECT post_stock_journal('00000000-0000-0000-0000-00000000b003', CURRENT_DATE, '00000000-0000-0000-0000-00000000b0c1', 'x',
   jsonb_build_array(jsonb_build_object('batch_id', (SELECT batch_id FROM purchase_invoice_lines WHERE invoice_id = (SELECT id FROM purchase_invoices WHERE invoice_number = 'PI-901')), 'qty', 101)),
   jsonb_build_array(jsonb_build_object('product_id','00000000-0000-0000-0000-00000000b0a1','qty',100)))$$, 'available at this location');
SELECT t_fails('journal needs something coming in', $$SELECT post_stock_journal('00000000-0000-0000-0000-00000000b003', CURRENT_DATE, '00000000-0000-0000-0000-00000000b0c1', 'x',
   jsonb_build_array(jsonb_build_object('batch_id', (SELECT batch_id FROM purchase_invoice_lines WHERE invoice_id = (SELECT id FROM purchase_invoices WHERE invoice_number = 'PI-901')), 'qty', 10)), '[]'::jsonb)$$, 'coming in');
SELECT t_fails('viewer cannot post a stock journal', $$SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000b004', false), post_stock_journal('00000000-0000-0000-0000-00000000b003', CURRENT_DATE, '00000000-0000-0000-0000-00000000b0c1', 'x',
   jsonb_build_array(jsonb_build_object('batch_id', (SELECT batch_id FROM purchase_invoice_lines LIMIT 1), 'qty', 1)),
   jsonb_build_array(jsonb_build_object('product_id','00000000-0000-0000-0000-00000000b0a1','qty',1)))$$, 'Only an admin');
SELECT set_config('request.jwt.claim.sub', :U, false);

SELECT post_stock_journal('00000000-0000-0000-0000-00000000b003', CURRENT_DATE, '00000000-0000-0000-0000-00000000b0c1',
   'Billed as B against physical A (PI-901 / MEMO-1)',
   jsonb_build_array(jsonb_build_object('batch_id', (SELECT batch_id FROM purchase_invoice_lines WHERE invoice_id = (SELECT id FROM purchase_invoices WHERE invoice_number = 'PI-901')), 'qty', 100)),
   jsonb_build_array(jsonb_build_object('product_id','00000000-0000-0000-0000-00000000b0a1','qty',100,'batch_number','X-A-1')),
   (SELECT id FROM memo_settlements ORDER BY created_at LIMIT 1), (SELECT id FROM purchase_invoices WHERE invoice_number = 'PI-901'));
SELECT t_eq('journal: B out (left: PI-902 15 + PI-Z1 5)', t_stock('00000000-0000-0000-0000-00000000b0b1'), 20);
SELECT t_eq('journal: A in', t_stock('00000000-0000-0000-0000-00000000b0a1'), 110);
SELECT t_eq('journal carries the VALUE (1000 / 100 = 10 per bag)', (SELECT landing_cost_per_unit FROM batch_register WHERE batch_number = 'X-A-1'), 10);
SELECT t_eq('journal total value recorded', (SELECT total_value FROM stock_journals), 1000);
SELECT t_eq('journal is linked to the settlement and the invoice', (SELECT COUNT(*) FROM stock_journals WHERE memo_settlement_id IS NOT NULL AND purchase_invoice_id IS NOT NULL), 1);
SELECT t_eq('journal number', (SELECT COUNT(*) FROM stock_journals WHERE journal_no ~ '^SJ-[0-9]{4}-00001$'), 1);
SELECT t_near('a stock journal does not touch the Stock account', t_dr('1020'), 1233.33, 0.01);
SELECT t_fails('incoming journal batches are always new', $$SELECT post_stock_journal('00000000-0000-0000-0000-00000000b003', CURRENT_DATE, '00000000-0000-0000-0000-00000000b0c1', 'x',
   jsonb_build_array(jsonb_build_object('batch_id', (SELECT batch_id FROM purchase_invoice_lines WHERE invoice_id = (SELECT id FROM purchase_invoices WHERE invoice_number = 'PI-902')), 'qty', 1)),
   jsonb_build_array(jsonb_build_object('product_id','00000000-0000-0000-0000-00000000b0a1','qty',1,'batch_number','X-A-1')))$$, 'already exists');

-- 3b. memo line 2 (15 units; 5 already sold) against PI-902 (15 x B @ 8)
SELECT settle_memo_with_invoice('00000000-0000-0000-0000-00000000b5a1', (SELECT id FROM purchase_invoices WHERE invoice_number = 'PI-902'),
   jsonb_build_array(jsonb_build_object('memo_line_id','00000000-0000-0000-0000-00000000b6a2',
                                        'invoice_line_id',(SELECT id FROM purchase_invoice_lines WHERE invoice_id = (SELECT id FROM purchase_invoices WHERE invoice_number = 'PI-902')),
                                        'units',15)));
SELECT t_eq('part-sold: 10 units were still on hand', (SELECT units_on_hand FROM memo_settlement_lines WHERE units = 15), 10);
SELECT t_eq('part-sold: 5 units were already sold', (SELECT units_sold FROM memo_settlement_lines WHERE units = 15), 5);
SELECT t_near('part-sold: invoice vs memo cost difference on the sold units goes to COGS (5 x (8 - 6.3333))',
  t_jv((SELECT id FROM memo_settlements ORDER BY created_at DESC LIMIT 1), '4001', 'dr'), 8.33, 0.01);
SELECT t_near('COGS ends at the true invoice cost of the 5 sold units (5 x 8)', t_dr('4001'), 40, 0.01);
SELECT t_eq('memo fully settled: nothing pending', (SELECT COUNT(*) FROM vw_memo_pending WHERE memo_no = 'MEMO-1'), 0);
SELECT t_eq('pending liability fully cleared', t_dr('2005'), 0);
SELECT t_eq('the 10 on-hand memo units left the ledger', (SELECT current_qty FROM batch_register WHERE batch_number = 'MEMO-B2'), 0);
SELECT t_eq('invoice stock for the 5 sold units went out too (PI-902 15 - 5, plus PI-Z1 5)', t_stock('00000000-0000-0000-0000-00000000b0b1'), 15);

-- 4. GOODS THAT WILL NEVER BE BILLED: RETURN / WAIVED --------------------------------------------------
INSERT INTO memo_purchases(id, tenant_id, organisation_id, memo_no, supplier_id, received_at_location, supplier_ref)
VALUES ('00000000-0000-0000-0000-00000000b5a2', :T, :O, 'MEMO-2', '00000000-0000-0000-0000-00000000b0e1', '00000000-0000-0000-0000-00000000b0c1', 'CH-78'),
       ('00000000-0000-0000-0000-00000000b5a3', :T, :O, 'MEMO-3', '00000000-0000-0000-0000-00000000b0e1', '00000000-0000-0000-0000-00000000b0c1', 'CH-79'),
       ('00000000-0000-0000-0000-00000000b5a4', :T, :O, 'MEMO-4', '00000000-0000-0000-0000-00000000b0e1', '00000000-0000-0000-0000-00000000b0c1', 'CH-80');
INSERT INTO memo_purchase_lines(id, tenant_id, memo_id, line_no, product_id, qty, unit_of_measure, rate) VALUES
  ('00000000-0000-0000-0000-00000000b6b2', :T, '00000000-0000-0000-0000-00000000b5a2', 1, '00000000-0000-0000-0000-00000000b0a1', 20, 'BAG', 10),
  ('00000000-0000-0000-0000-00000000b6b3', :T, '00000000-0000-0000-0000-00000000b5a3', 1, '00000000-0000-0000-0000-00000000b0a1', 10, 'BAG', 10),
  ('00000000-0000-0000-0000-00000000b6b4', :T, '00000000-0000-0000-0000-00000000b5a4', 1, '00000000-0000-0000-0000-00000000b0a1', 5, 'BAG', 10);
SELECT post_memo_purchase(id) FROM memo_purchases WHERE memo_no IN ('MEMO-2', 'MEMO-3', 'MEMO-4') ORDER BY memo_no;

SELECT t_fails('closing needs a reason', $$SELECT close_memo_units('00000000-0000-0000-0000-00000000b6b2', 20, 'RETURN', ' ')$$, 'reason is required');
SELECT t_fails('cannot close more than is pending', $$SELECT close_memo_units('00000000-0000-0000-0000-00000000b6b2', 21, 'RETURN', 'x')$$, 'still pending');
SELECT t_fails('mode must be valid', $$SELECT close_memo_units('00000000-0000-0000-0000-00000000b6b2', 1, 'DELETE', 'x')$$, 'RETURN or WAIVED');
SELECT close_memo_units('00000000-0000-0000-0000-00000000b6b2', 20, 'RETURN', 'Sent back to X, not wanted');
SELECT t_eq('returned: stock gone', (SELECT current_qty FROM batch_register WHERE batch_number = 'MEMO-2-L1'), 0);
SELECT t_eq('returned: line closed', (SELECT returned_units FROM memo_purchase_lines WHERE memo_id = '00000000-0000-0000-0000-00000000b5a2'), 20);
SELECT close_memo_units('00000000-0000-0000-0000-00000000b6b3', 10, 'WAIVED', 'X confirmed the goods are free of charge');
SELECT t_eq('waived: stock stays', (SELECT current_qty FROM batch_register WHERE batch_number = 'MEMO-3-L1'), 10);
SELECT t_eq('waived: income recognised (journal ref is the memo line)', t_jv('00000000-0000-0000-0000-00000000b6b3', '3020', 'cr'), 100);
-- goods already sold cannot be returned: sell 3 of MEMO-4's 5, then try to return all 5
SELECT t_sale('SI-2', (SELECT batch_id FROM memo_purchase_lines WHERE memo_id = '00000000-0000-0000-0000-00000000b5a4'), '00000000-0000-0000-0000-00000000b0a1', 3, 20);
SELECT t_fails('sold goods cannot be returned to the supplier', $$SELECT close_memo_units('00000000-0000-0000-0000-00000000b6b4', 5, 'RETURN', 'x')$$, 'already sold');

-- 5. THE BOOKS TIE OUT ---------------------------------------------------------------------------------
SELECT t_eq('books balance', (SELECT SUM(period_debit) - SUM(period_credit) FROM vw_trial_balance), 0);
SELECT t_eq('GL pending liability == pending-invoice report', t_dr('2005') * -1, (SELECT COALESCE(SUM(pending_value), 0) FROM vw_memo_pending));
SELECT t_eq('only MEMO-4 (5 units @10) is still waiting for X''s invoice', (SELECT pending_value FROM vw_memo_pending_by_supplier WHERE supplier_name = 'Co-distributor X'), 50);
SELECT t_near('GL stock account == stock sub-ledger (units x batch cost)', t_dr('1020'), t_stock_value(), 0.10);

-- 6. USERS CANNOT FORGE ANY OF THIS ------------------------------------------------------------------
SELECT t_fails('settlements cannot be inserted by hand', $$INSERT INTO memo_settlements(tenant_id, organisation_id, memo_id, purchase_invoice_id)
   VALUES ('00000000-0000-0000-0000-00000000b001','00000000-0000-0000-0000-00000000b003','00000000-0000-0000-0000-00000000b5a1',(SELECT id FROM purchase_invoices LIMIT 1))$$, 'permission denied');
SELECT t_fails('stock journals cannot be inserted by hand', $$INSERT INTO stock_journals(tenant_id, organisation_id, journal_no, journal_date, location_id, reason, total_value)
   VALUES ('00000000-0000-0000-0000-00000000b001','00000000-0000-0000-0000-00000000b003','SJ-HACK',CURRENT_DATE,'00000000-0000-0000-0000-00000000b0c1','x',1)$$, 'permission denied');
SELECT t_fails('closures cannot be deleted', $$DELETE FROM memo_closures$$, 'permission denied');
UPDATE memo_purchases SET supplier_ref = 'CHANGED' WHERE memo_no = 'MEMO-1';
SELECT t_eq('posted memo unchanged (RLS hides it from updates)', (SELECT COUNT(*) FROM memo_purchases WHERE memo_no = 'MEMO-1' AND supplier_ref = 'CH-77'), 1);

-- 7. TENANT ISOLATION -------------------------------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', :U2, false);
SELECT t_eq('other tenant sees no memos', (SELECT COUNT(*) FROM memo_purchases), 0);
SELECT t_eq('other tenant sees no pending list', (SELECT COUNT(*) FROM vw_memo_pending), 0);
SELECT t_eq('other tenant sees no stock journals', (SELECT COUNT(*) FROM stock_journals), 0);
SELECT t_fails('other tenant cannot post our memo', $$SELECT post_memo_purchase('00000000-0000-0000-0000-00000000b5a1')$$, 'Memo purchase not found');
SELECT t_fails('other tenant cannot close our memo line', $$SELECT close_memo_units('00000000-0000-0000-0000-00000000b6b4', 1, 'WAIVED', 'x')$$, 'Memo line not found');

RESET ROLE;
DROP FUNCTION public.t_eq(text,numeric,numeric), public.t_near(text,numeric,numeric,numeric), public.t_fails(text,text,text), public.t_dr(text),
  public.t_jv(uuid,text,text), public.t_stock(uuid), public.t_stock_value(), public.t_pi(text,uuid,uuid,numeric,numeric,numeric,boolean),
  public.t_sale(text,uuid,uuid,numeric,numeric);
\echo E2E PASSED
