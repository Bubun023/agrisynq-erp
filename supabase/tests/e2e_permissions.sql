-- ============================================================
-- Role permissions end-to-end test (requires migrations 001-049)
-- Proves what each role can and cannot do, and that no tenant table escapes the read-only guard.
-- ============================================================
\set ON_ERROR_STOP on
\set T  '''00000000-0000-0000-0000-00000000f901'''
\set T2 '''00000000-0000-0000-0000-00000000f902'''
\set O  '''00000000-0000-0000-0000-00000000f903'''
\set UA '''00000000-0000-0000-0000-00000000f911'''
\set UB '''00000000-0000-0000-0000-00000000f912'''
\set UC '''00000000-0000-0000-0000-00000000f913'''
\set US '''00000000-0000-0000-0000-00000000f914'''
\set UK '''00000000-0000-0000-0000-00000000f915'''
\set UF '''00000000-0000-0000-0000-00000000f916'''
\set UV '''00000000-0000-0000-0000-00000000f917'''

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
-- draft documents for the behaviour tests
CREATE OR REPLACE FUNCTION public.t_pi(no text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE id uuid := gen_random_uuid();
BEGIN
  INSERT INTO purchase_invoices(id, tenant_id, organisation_id, invoice_number, invoice_date, supplier_id, received_at_location,
     gross_amount, taxable_amount, cgst_amount, sgst_amount, net_payable, status)
  VALUES (id, '00000000-0000-0000-0000-00000000f901', '00000000-0000-0000-0000-00000000f903', no, CURRENT_DATE,
     '00000000-0000-0000-0000-00000000f9e1', '00000000-0000-0000-0000-00000000f9c1', 1000, 1000, 25, 25, 1050, 'DRAFT');
  INSERT INTO purchase_invoice_lines(invoice_id, tenant_id, line_no, product_id, hsn_code, received_qty, unit_of_measure, unit_price,
     taxable_amount, gst_rate, cgst_amount, sgst_amount, line_total)
  VALUES (id, '00000000-0000-0000-0000-00000000f901', 1, '00000000-0000-0000-0000-00000000f9d1', '3102', 100, 'BAG', 10, 1000, 5, 25, 25, 1050);
  RETURN id;
END $$;
CREATE OR REPLACE FUNCTION public.t_si(no text, bat uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE id uuid := gen_random_uuid();
BEGIN
  INSERT INTO sales_invoices(id, tenant_id, organisation_id, invoice_number, invoice_date, sale_type, customer_id, from_location,
     gross_amount, taxable_amount, cgst_amount, sgst_amount, net_receivable, status)
  VALUES (id, '00000000-0000-0000-0000-00000000f901', '00000000-0000-0000-0000-00000000f903', no, CURRENT_DATE, 'CREDIT',
     '00000000-0000-0000-0000-00000000f9e2', '00000000-0000-0000-0000-00000000f9c1', 100, 100, 2.5, 2.5, 105, 'DRAFT');
  INSERT INTO sales_invoice_lines(invoice_id, tenant_id, line_no, product_id, hsn_code, batch_id, qty, unit_of_measure, unit_price,
     taxable_amount, gst_rate, cgst_amount, sgst_amount, line_total)
  VALUES (id, '00000000-0000-0000-0000-00000000f901', 1, '00000000-0000-0000-0000-00000000f9d1', '3102', bat, 5, 'BAG', 20, 100, 5, 2.5, 2.5, 105);
  RETURN id;
END $$;
CREATE OR REPLACE FUNCTION public.t_as(uid uuid) RETURNS void LANGUAGE sql AS $$ SELECT set_config('request.jwt.claim.sub', uid::text, false) $$;
GRANT EXECUTE ON FUNCTION public.t_eq(text,numeric,numeric), public.t_fails(text,text,text), public.t_pi(text),
  public.t_si(text,uuid), public.t_as(uuid) TO authenticated;

-- ── setup (superuser; no signed-in user, so the guard does not apply) ──
INSERT INTO tenants(id, slug, name) VALUES (:T, 'perm-1', 'Perm One'), (:T2, 'perm-2', 'Perm Two');
SELECT onboard_tenant(:T, 'Perm One');
INSERT INTO auth.users(id, email) VALUES (:UA,'a@p.t'),(:UB,'b@p.t'),(:UC,'c@p.t'),(:US,'s@p.t'),(:UK,'k@p.t'),(:UF,'f@p.t'),(:UV,'v@p.t');
INSERT INTO user_profiles(id, tenant_id, full_name) SELECT id, :T, email FROM auth.users WHERE id IN (:UA,:UB,:UC,:US,:UK,:UF,:UV);
INSERT INTO organisations(id, tenant_id, legal_name) VALUES (:O, :T, 'Perm Agro');
INSERT INTO user_roles(tenant_id, user_id, role_id, organisation_id)
SELECT :T, v.u::uuid, r.id, :O FROM (VALUES (:UA,'SUPER_ADMIN'),(:UB,'BRANCH_ADMIN'),(:UC,'ACCOUNTANT'),(:US,'SALES_MANAGER'),
                                    (:UK,'STOCK_MANAGER'),(:UF,'FMS_COMPLIANCE'),(:UV,'VIEWER')) v(u, rn)
  JOIN roles r ON r.tenant_id = :T AND r.name = v.rn;
INSERT INTO locations(id, tenant_id, organisation_id, name, location_type) VALUES
  ('00000000-0000-0000-0000-00000000f9c1', :T, :O, 'Main', 'OWN');
INSERT INTO products(id, tenant_id, organisation_id, name, category, hsn_code, unit_of_measure, gst_rate, batch_required)
  VALUES ('00000000-0000-0000-0000-00000000f9d1', :T, :O, 'Urea', 'FERTILIZER', '3102', 'BAG', 5, true);
INSERT INTO parties(id, tenant_id, organisation_id, name, party_type) VALUES
  ('00000000-0000-0000-0000-00000000f9e1', :T, :O, 'Supplier', 'SUPPLIER'),
  ('00000000-0000-0000-0000-00000000f9e2', :T, :O, 'Customer', 'CUSTOMER');
INSERT INTO chart_of_accounts(tenant_id, organisation_id, account_code, account_name, account_type, account_group)
SELECT :T, :O, c, n, t::account_type_enum, 'g' FROM (VALUES
 ('1001','Cash','ASSET'),('1002','Bank','ASSET'),('1010','Debtors','ASSET'),('1020','Stock','ASSET'),('2001','Creditors','LIABILITY'),
 ('2010','CGST','LIABILITY'),('2011','SGST','LIABILITY'),('2012','IGST','LIABILITY'),('3001','Sales','INCOME'),('3002','S2','INCOME'),
 ('3003','S3','INCOME'),('3020','Other','INCOME'),('4001','COGS','EXPENSE'),('4002','C2','EXPENSE'),('4003','C3','EXPENSE'),
 ('4040','ITC','ASSET'),('4041','ITC2','ASSET'),('4042','ITC3','ASSET')) v(c,n,t);

-- 1. NO TENANT TABLE ESCAPES THE READ-ONLY GUARD ----------------------------------------------
SELECT t_eq('every tenant table has the read-only guard (missing = 0)', (
  SELECT COUNT(*) FROM information_schema.columns c
    JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
   WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id' AND c.table_name NOT IN ('audit_logs', 'user_profiles')
     AND NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = ('public.' || quote_ident(c.table_name))::regclass AND g.tgname = 'a_readonly_guard')), 0);

-- 2. EVERY POSTING / APPROVAL FUNCTION CHECKS A PERMISSION --------------------------------------
SELECT t_eq('all 23 posting/approval functions carry require_permission', (
  SELECT COUNT(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prosrc LIKE '%require_permission(%' AND proname <> 'require_permission'), 23);

-- 3. THE MATRIX (has_permission as each role) ----------------------------------------------------
SET ROLE authenticated;
SELECT t_as(:UA);
SELECT t_eq('SUPER_ADMIN: sales.post / purchases.post / admin_users.create / admin_periods.approve',
  (has_permission('sales','post'))::int + (has_permission('purchases','post'))::int + (has_permission('admin_users','create'))::int + (has_permission('admin_periods','approve'))::int, 4);
SELECT t_as(:UB);
SELECT t_eq('BRANCH_ADMIN: sales/purchases/accounting/inventory/fms posting', (has_permission('sales','post'))::int + (has_permission('purchases','post'))::int
  + (has_permission('accounting','post'))::int + (has_permission('inventory','post'))::int + (has_permission('fms','approve'))::int, 5);
SELECT t_eq('BRANCH_ADMIN: no user admin, no period locks, no audit log', (has_permission('admin_users','create'))::int + (has_permission('admin_periods','approve'))::int + (has_permission('audit_log','read'))::int, 0);
SELECT t_as(:UC);
SELECT t_eq('ACCOUNTANT: accounting.post + purchases.post + purchases.create + sales.post', (has_permission('accounting','post'))::int + (has_permission('purchases','post'))::int + (has_permission('purchases','create'))::int + (has_permission('sales','post'))::int, 4);
SELECT t_eq('ACCOUNTANT: not inventory.post', (has_permission('inventory','post'))::int, 0);
SELECT t_as(:US);
SELECT t_eq('SALES_MANAGER: sales.post yes; purchases.post / accounting.post no', (has_permission('sales','post'))::int * 10 + (has_permission('purchases','post'))::int + (has_permission('accounting','post'))::int, 10);
SELECT t_as(:UK);
SELECT t_eq('STOCK_MANAGER: inventory.post + approve yes; sales.post no', (has_permission('inventory','post'))::int + (has_permission('inventory','approve'))::int - (has_permission('sales','post'))::int * 5, 2);
SELECT t_as(:UF);
SELECT t_eq('FMS_COMPLIANCE: fms.approve + fms.import yes; sales.post no', (has_permission('fms','approve'))::int + (has_permission('fms','import'))::int - (has_permission('sales','post'))::int * 5, 2);
SELECT t_as(:UV);
SELECT t_eq('VIEWER: cannot post anything and cannot write', (has_permission('sales','post'))::int + (has_permission('purchases','post'))::int + (has_permission('accounting','post'))::int + (can_write())::int, 0);

-- 4. BEHAVIOUR: who can post what ---------------------------------------------------------------
SELECT t_as(:UA);
SELECT t_pi('PI-OK-ADMIN');
SELECT t_pi('PI-BY-SALES');
SELECT t_pi('PI-BY-STOCK');
SELECT t_pi('PI-BY-ACCT');
SELECT t_pi('PI-BY-BRANCH');
SELECT t_pi('PI-BY-VIEWER');
SELECT post_purchase_invoice((SELECT id FROM purchase_invoices WHERE invoice_number = 'PI-OK-ADMIN'));
SELECT t_eq('admin posted a purchase invoice', (SELECT (status = 'POSTED')::int FROM purchase_invoices WHERE invoice_number = 'PI-OK-ADMIN'), 1);

SELECT t_as(:US);
SELECT t_fails('sales manager cannot post a purchase invoice', $$SELECT post_purchase_invoice((SELECT id FROM purchase_invoices WHERE invoice_number = 'PI-BY-SALES'))$$, 'permission to post purchases');
SELECT t_as(:UK);
SELECT t_fails('stock manager cannot post a purchase invoice', $$SELECT post_purchase_invoice((SELECT id FROM purchase_invoices WHERE invoice_number = 'PI-BY-STOCK'))$$, 'permission to post purchases');
SELECT t_as(:UV);
SELECT t_fails('viewer cannot post a purchase invoice', $$SELECT post_purchase_invoice((SELECT id FROM purchase_invoices WHERE invoice_number = 'PI-BY-VIEWER'))$$, 'permission to post purchases');
SELECT t_as(:UC);
SELECT post_purchase_invoice((SELECT id FROM purchase_invoices WHERE invoice_number = 'PI-BY-ACCT'));
SELECT t_eq('accountant posted a purchase invoice', (SELECT (status = 'POSTED')::int FROM purchase_invoices WHERE invoice_number = 'PI-BY-ACCT'), 1);
SELECT t_as(:UB);
SELECT post_purchase_invoice((SELECT id FROM purchase_invoices WHERE invoice_number = 'PI-BY-BRANCH'));
SELECT t_eq('branch admin posted a purchase invoice', (SELECT (status = 'POSTED')::int FROM purchase_invoices WHERE invoice_number = 'PI-BY-BRANCH'), 1);

-- sales: sales manager and admin can; accountant too; stock manager, FMS officer and viewer cannot
SELECT t_as(:UA);
SELECT t_si('SI-BY-SALES', (SELECT batch_id FROM purchase_invoice_lines WHERE invoice_id = (SELECT id FROM purchase_invoices WHERE invoice_number = 'PI-OK-ADMIN')));
SELECT t_si('SI-BY-ACCT',  (SELECT batch_id FROM purchase_invoice_lines WHERE invoice_id = (SELECT id FROM purchase_invoices WHERE invoice_number = 'PI-OK-ADMIN')));
SELECT t_si('SI-BY-STOCK', (SELECT batch_id FROM purchase_invoice_lines WHERE invoice_id = (SELECT id FROM purchase_invoices WHERE invoice_number = 'PI-OK-ADMIN')));
SELECT t_si('SI-BY-FMS',   (SELECT batch_id FROM purchase_invoice_lines WHERE invoice_id = (SELECT id FROM purchase_invoices WHERE invoice_number = 'PI-OK-ADMIN')));
SELECT t_si('SI-BY-VIEWER',(SELECT batch_id FROM purchase_invoice_lines WHERE invoice_id = (SELECT id FROM purchase_invoices WHERE invoice_number = 'PI-OK-ADMIN')));
SELECT t_as(:US);
SELECT post_sales_invoice((SELECT id FROM sales_invoices WHERE invoice_number = 'SI-BY-SALES'));
SELECT t_eq('sales manager posted a sales invoice', (SELECT (status = 'POSTED')::int FROM sales_invoices WHERE invoice_number = 'SI-BY-SALES'), 1);
SELECT t_as(:UC);
SELECT post_sales_invoice((SELECT id FROM sales_invoices WHERE invoice_number = 'SI-BY-ACCT'));
SELECT t_eq('accountant posted a sales invoice', (SELECT (status = 'POSTED')::int FROM sales_invoices WHERE invoice_number = 'SI-BY-ACCT'), 1);
SELECT t_as(:UK);
SELECT t_fails('stock manager cannot post a sales invoice', $$SELECT post_sales_invoice((SELECT id FROM sales_invoices WHERE invoice_number = 'SI-BY-STOCK'))$$, 'permission to post sales');
SELECT t_as(:UF);
SELECT t_fails('FMS officer cannot post a sales invoice', $$SELECT post_sales_invoice((SELECT id FROM sales_invoices WHERE invoice_number = 'SI-BY-FMS'))$$, 'permission to post sales');
SELECT t_as(:UV);
SELECT t_fails('viewer cannot post a sales invoice', $$SELECT post_sales_invoice((SELECT id FROM sales_invoices WHERE invoice_number = 'SI-BY-VIEWER'))$$, 'permission to post sales');

-- 5. A READ-ONLY ROLE CANNOT CHANGE ANYTHING, BY ANY ROUTE ----------------------------------------
SELECT t_fails('viewer cannot insert a party', $$INSERT INTO parties(tenant_id, organisation_id, name, party_type) VALUES ('00000000-0000-0000-0000-00000000f901','00000000-0000-0000-0000-00000000f903','X','CUSTOMER')$$, 'read-only');
SELECT t_fails('viewer cannot update a party', $$UPDATE parties SET name = 'hacked'$$, 'read-only');
SELECT t_fails('viewer cannot create a draft invoice', $$SELECT t_si('SI-VIEWER-DRAFT', (SELECT id FROM batch_register LIMIT 1))$$, 'read-only');
SELECT t_fails('viewer cannot record a stock movement', $$INSERT INTO stock_ledger(tenant_id, organisation_id, movement_type, product_id, to_location_id, qty, unit_of_measure)
   VALUES ('00000000-0000-0000-0000-00000000f901','00000000-0000-0000-0000-00000000f903','OPENING','00000000-0000-0000-0000-00000000f9d1','00000000-0000-0000-0000-00000000f9c1',1,'BAG')$$, 'read-only');
SELECT t_eq('a viewer can still read', (SELECT COUNT(*) FROM parties), 2);
SELECT t_as(:UC);
INSERT INTO parties(tenant_id, organisation_id, name, party_type) VALUES (:T, :O, 'Written by accountant', 'CUSTOMER');
SELECT t_eq('an accountant can write master data (draft-level work)', (SELECT COUNT(*) FROM parties WHERE name = 'Written by accountant'), 1);

-- 6. NEW TENANTS GET THE COMPLETED MATRIX; UNSIGNED-IN CONTEXTS ARE NOT BLOCKED ----------------------
RESET ROLE;
SELECT onboard_tenant(:T2, 'Perm Two');
SELECT t_eq('a freshly onboarded tenant: BRANCH_ADMIN has permissions', ((SELECT COUNT(*) FROM role_permissions rp JOIN roles r ON r.id = rp.role_id WHERE r.tenant_id = :T2 AND r.name = 'BRANCH_ADMIN') > 20)::int, 1);
SELECT t_eq('a freshly onboarded tenant: ACCOUNTANT can post purchases', (SELECT COUNT(*) FROM role_permissions rp JOIN roles r ON r.id = rp.role_id
   JOIN permissions p ON p.id = rp.permission_id WHERE r.tenant_id = :T2 AND r.name = 'ACCOUNTANT' AND p.module = 'purchases' AND p.action = 'post'), 1);
SELECT set_config('request.jwt.claim.sub', '', false);
INSERT INTO parties(tenant_id, organisation_id, name, party_type) VALUES (:T, :O, 'Written by migration', 'CUSTOMER');
SELECT t_eq('with no signed-in user (migrations / service key) writes are not blocked', (SELECT COUNT(*) FROM parties WHERE name = 'Written by migration'), 1);

DROP FUNCTION public.t_eq(text,numeric,numeric), public.t_fails(text,text,text), public.t_pi(text), public.t_si(text,uuid), public.t_as(uuid);
\echo E2E PASSED
