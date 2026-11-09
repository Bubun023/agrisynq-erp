-- ============================================================
-- FMS import & matching test (requires migrations 001-042)
-- ============================================================
\set ON_ERROR_STOP on
\set T  '''00000000-0000-0000-0000-00000000e001'''
\set U  '''00000000-0000-0000-0000-00000000e002'''
\set O  '''00000000-0000-0000-0000-00000000e003'''
\set T2 '''00000000-0000-0000-0000-00000000e101'''
\set U2 '''00000000-0000-0000-0000-00000000e102'''

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
GRANT EXECUTE ON FUNCTION public.t_eq(text,numeric,numeric), public.t_fails(text,text,text) TO authenticated;

-- ── setup (superuser): sales in various states, inserted directly ──
INSERT INTO tenants(id, slug, name) VALUES (:T, 'imp-1', 'Imp One'), (:T2, 'imp-2', 'Imp Two');
SELECT onboard_tenant(:T, 'Imp One'); SELECT onboard_tenant(:T2, 'Imp Two');
INSERT INTO auth.users(id, email) VALUES (:U, 'i1@imp.test'), (:U2, 'i2@imp.test');
INSERT INTO user_profiles(id, tenant_id, full_name) VALUES (:U, :T, 'Imp Admin'), (:U2, :T2, 'Other Admin');
INSERT INTO organisations(id, tenant_id, legal_name) VALUES (:O, :T, 'Imp Agro');
INSERT INTO user_roles(tenant_id, user_id, role_id, organisation_id)
  SELECT :T, :U, id, :O FROM roles WHERE tenant_id = :T AND name = 'SUPER_ADMIN';
INSERT INTO locations(id, tenant_id, organisation_id, name, location_type)
  VALUES ('00000000-0000-0000-0000-00000000e0c1', :T, :O, 'Shop', 'OWN');
INSERT INTO products(id, tenant_id, organisation_id, name, category, hsn_code, unit_of_measure, gst_rate)
  VALUES ('00000000-0000-0000-0000-00000000e0d1', :T, :O, 'Urea', 'FERTILIZER', '3102', 'BAG', 5);
INSERT INTO farmers(id, tenant_id, organisation_id, first_name, last_name)
  VALUES ('00000000-0000-0000-0000-00000000e0f1', :T, :O, 'Sita', 'Devi');

CREATE TEMP TABLE _mk(n text, pos text, qty numeric, sub numeric, st text);
INSERT INTO _mk VALUES
 ('S1','P1',10,150,'POSTED'), ('S2','P2',5,75,'POSTED'), ('S3','P3',4,60,'POSTED'),
 ('S4','P4',2,30,'CANCELLED'), ('S5','P5',3,45,'POS_RECORDED'), ('S6','P6',7,105,'POSTED');
INSERT INTO farmer_sales(tenant_id, organisation_id, sale_number, sale_date, farmer_id, farmer_name, sale_at_location, product_id,
   hsn_code, qty_sold, unit_of_measure, selling_price_per_unit, subsidy_per_unit, gross_amount, total_subsidy_amount,
   farmer_payable_amount, net_amount, cash_received, subsidy_type, fms_dealer_id, pos_transaction_id, status)
SELECT :T, :O, n, CURRENT_DATE, '00000000-0000-0000-0000-00000000e0f1', 'Sita Devi', '00000000-0000-0000-0000-00000000e0c1',
       '00000000-0000-0000-0000-00000000e0d1', '3102', qty, 'BAG', 20, sub / qty, qty * 20, sub, qty * 20 - sub, qty * 20 - sub,
       qty * 20 - sub, 'NEEM_COATED_UREA', 'DLR-9', pos, st::farmer_sale_status
  FROM _mk;

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :U, false);

-- portal file: P1 ok, P2 wrong qty, P3 wrong subsidy, P4 cancelled by us, P5 unposted, P7 unknown,
--              " p1 " duplicate of P1, a line with no id.  P6 is absent from the file.
SELECT t_eq('import runs', (SELECT total_lines FROM import_fms_data(
  '00000000-0000-0000-0000-00000000e003', 'portal.csv', 'DLR-9', date_trunc('month', CURRENT_DATE)::date, CURRENT_DATE,
  '[{"pos_id":"P1","qty":10,"subsidy":150,"ack":"ACK-1","farmer":"Sita Devi"},
    {"pos_id":"P2","qty":6,"subsidy":75},
    {"pos_id":"P3","qty":4,"subsidy":50},
    {"pos_id":"P4","qty":2,"subsidy":30},
    {"pos_id":"P5","qty":3,"subsidy":45},
    {"pos_id":"P7","qty":1,"subsidy":15},
    {"pos_id":" p1 ","qty":10,"subsidy":150},
    {"qty":9,"subsidy":9}]'::jsonb)), 8);

SELECT t_eq('P1 MATCHED', (SELECT COUNT(*) FROM fms_import_lines WHERE pos_transaction_id = 'P1' AND match_status = 'MATCHED'), 1);
SELECT t_eq('P2 QTY_MISMATCH', (SELECT COUNT(*) FROM fms_import_lines WHERE pos_transaction_id = 'P2' AND match_status = 'QTY_MISMATCH'), 1);
SELECT t_eq('P2 note shows both quantities', (SELECT COUNT(*) FROM fms_import_lines WHERE pos_transaction_id = 'P2' AND note LIKE '%6%5%'), 1);
SELECT t_eq('P3 SUBSIDY_MISMATCH', (SELECT COUNT(*) FROM fms_import_lines WHERE pos_transaction_id = 'P3' AND match_status = 'SUBSIDY_MISMATCH'), 1);
SELECT t_eq('P4 CANCELLED_IN_SYSTEM', (SELECT COUNT(*) FROM fms_import_lines WHERE pos_transaction_id = 'P4' AND match_status = 'CANCELLED_IN_SYSTEM'), 1);
SELECT t_eq('P5 NOT_POSTED', (SELECT COUNT(*) FROM fms_import_lines WHERE pos_transaction_id = 'P5' AND match_status = 'NOT_POSTED'), 1);
SELECT t_eq('P7 MISSING_IN_SYSTEM', (SELECT COUNT(*) FROM fms_import_lines WHERE pos_transaction_id = 'P7' AND match_status = 'MISSING_IN_SYSTEM'), 1);
SELECT t_eq('repeat of P1 flagged DUPLICATE_IN_FILE (case/space-insensitive)', (SELECT COUNT(*) FROM fms_import_lines WHERE match_status = 'DUPLICATE_IN_FILE'), 1);
SELECT t_eq('line without id INVALID', (SELECT COUNT(*) FROM fms_import_lines WHERE match_status = 'INVALID'), 1);

-- batch totals
SELECT t_eq('batch matched', (SELECT matched FROM fms_import_batches), 1);
SELECT t_eq('batch mismatched', (SELECT mismatched FROM fms_import_batches), 2);
SELECT t_eq('batch missing_in_system', (SELECT missing_in_system FROM fms_import_batches), 1);
SELECT t_eq('batch cancelled_in_system', (SELECT cancelled_in_system FROM fms_import_batches), 1);
SELECT t_eq('batch not_posted', (SELECT not_posted FROM fms_import_batches), 1);
SELECT t_eq('batch duplicates', (SELECT duplicate_in_file FROM fms_import_batches), 1);
SELECT t_eq('batch invalid', (SELECT invalid_lines FROM fms_import_batches), 1);
-- P2 and P3 have a portal line (mismatched) so only P6 is truly absent from the portal
SELECT t_eq('batch missing_in_portal', (SELECT missing_in_portal FROM fms_import_batches), 1);
SELECT t_eq('missing_in_portal report lists P6', (SELECT COUNT(*) FROM fms_import_missing_in_portal((SELECT id FROM fms_import_batches)) WHERE pos_transaction_id = 'P6'), 1);

-- matched sale stamped as synced
SELECT t_eq('matched sale got ack number', (SELECT COUNT(*) FROM farmer_sales WHERE pos_transaction_id = 'P1' AND fms_acknowledgement_no = 'ACK-1' AND fms_synced_at IS NOT NULL), 1);
SELECT t_eq('mismatched sale not stamped', (SELECT COUNT(*) FROM farmer_sales WHERE pos_transaction_id = 'P2' AND fms_synced_at IS NOT NULL), 0);

-- validation
SELECT t_fails('empty file rejected', $$SELECT import_fms_data('00000000-0000-0000-0000-00000000e003','x','DLR-9',CURRENT_DATE,CURRENT_DATE,'[]'::jsonb)$$, 'no transactions');
SELECT t_fails('dealer id required', $$SELECT import_fms_data('00000000-0000-0000-0000-00000000e003','x',' ',CURRENT_DATE,CURRENT_DATE,'[{"pos_id":"A"}]'::jsonb)$$, 'dealer ID is required');
SELECT t_fails('bad period rejected', $$SELECT import_fms_data('00000000-0000-0000-0000-00000000e003','x','D',CURRENT_DATE,CURRENT_DATE - 1,'[{"pos_id":"A"}]'::jsonb)$$, 'before period start');

-- users cannot tamper with stored imports
SELECT t_fails('users cannot edit import lines', $$UPDATE fms_import_lines SET match_status = 'MATCHED'$$, 'permission denied');
SELECT t_fails('users cannot delete import batches', $$DELETE FROM fms_import_batches$$, 'permission denied');
SELECT t_eq('import lines cannot be edited by users', (SELECT COUNT(*) FROM fms_import_lines WHERE match_status = 'MATCHED'), 1);
SELECT t_eq('import batches cannot be deleted by users', (SELECT COUNT(*) FROM fms_import_batches), 1);

-- tenant isolation
SELECT set_config('request.jwt.claim.sub', :U2, false);
SELECT t_eq('other tenant sees no import batches', (SELECT COUNT(*) FROM fms_import_batches), 0);
SELECT t_eq('other tenant sees no import lines', (SELECT COUNT(*) FROM fms_import_lines), 0);
SELECT t_fails('other tenant cannot import into this organisation',
  $$SELECT import_fms_data('00000000-0000-0000-0000-00000000e003','x','DLR-9',CURRENT_DATE,CURRENT_DATE,'[{"pos_id":"P1","qty":10,"subsidy":150}]'::jsonb)$$,
  'Organisation not found');

RESET ROLE;
DROP FUNCTION public.t_eq(text,numeric,numeric), public.t_fails(text,text,text);
\echo E2E PASSED
