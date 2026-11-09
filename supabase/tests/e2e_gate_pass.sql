-- ============================================================
-- Gate pass end-to-end test (requires migrations 001-045)
-- ============================================================
\set ON_ERROR_STOP on
\set T  '''00000000-0000-0000-0000-00000000a0a1'''
\set U  '''00000000-0000-0000-0000-00000000a0a2'''
\set O  '''00000000-0000-0000-0000-00000000a0a3'''
\set T2 '''00000000-0000-0000-0000-00000000a1a1'''
\set U2 '''00000000-0000-0000-0000-00000000a1a2'''

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
CREATE OR REPLACE FUNCTION public.t_gp(ref_type text, ref_id uuid, ptype gate_pass_type_enum, veh text DEFAULT 'MH12AB1234') RETURNS gate_passes
LANGUAGE sql AS $$ SELECT * FROM issue_gate_pass(ref_type, ref_id, ptype, veh, 'Raju', '9876543210', 40, 'Guard Singh', NULL) $$;
GRANT EXECUTE ON FUNCTION public.t_eq(text,numeric,numeric), public.t_fails(text,text,text),
  public.t_gp(text,uuid,gate_pass_type_enum,text) TO authenticated;

-- ── setup ──
INSERT INTO tenants(id, slug, name) VALUES (:T, 'gp-1', 'GP One'), (:T2, 'gp-2', 'GP Two');
SELECT onboard_tenant(:T, 'GP One'); SELECT onboard_tenant(:T2, 'GP Two');
INSERT INTO auth.users(id, email) VALUES (:U, 'g1@gp.test'), (:U2, 'g2@gp.test');
INSERT INTO user_profiles(id, tenant_id, full_name) VALUES (:U, :T, 'GP Admin'), (:U2, :T2, 'Other Admin');
INSERT INTO organisations(id, tenant_id, legal_name) VALUES (:O, :T, 'GP Agro');
INSERT INTO user_roles(tenant_id, user_id, role_id, organisation_id)
  SELECT :T, :U, id, :O FROM roles WHERE tenant_id = :T AND name = 'SUPER_ADMIN';
INSERT INTO locations(id, tenant_id, organisation_id, name, location_type) VALUES
  ('00000000-0000-0000-0000-00000000a0c1', :T, :O, 'Godown A', 'OWN'),
  ('00000000-0000-0000-0000-00000000a0c2', :T, :O, 'Godown B', 'OWN');
INSERT INTO products(id, tenant_id, organisation_id, name, category, hsn_code, unit_of_measure, gst_rate, batch_required)
  VALUES ('00000000-0000-0000-0000-00000000a0d1', :T, :O, 'MOP 50kg', 'FERTILIZER', '3104', 'BAG', 5, true);
INSERT INTO parties(id, tenant_id, organisation_id, name, party_type) VALUES
  ('00000000-0000-0000-0000-00000000a0e1', :T, :O, 'Supplier X', 'SUPPLIER'),
  ('00000000-0000-0000-0000-00000000a0e2', :T, :O, 'Customer Y', 'CUSTOMER');
INSERT INTO batch_register(id, tenant_id, organisation_id, batch_number, product_id, location_id, opening_qty, current_qty,
   unit_of_measure, purchase_rate, landing_cost_per_unit, status)
VALUES ('00000000-0000-0000-0000-00000000a0b1', :T, :O, 'MOP-1', '00000000-0000-0000-0000-00000000a0d1',
   '00000000-0000-0000-0000-00000000a0c1', 100, 0, 'BAG', 10, 10, 'OPEN');
INSERT INTO stock_ledger(tenant_id, organisation_id, movement_type, product_id, batch_id, to_location_id, qty, unit_of_measure)
VALUES (:T, :O, 'OPENING', '00000000-0000-0000-0000-00000000a0d1', '00000000-0000-0000-0000-00000000a0b1',
   '00000000-0000-0000-0000-00000000a0c1', 100, 'BAG');
-- documents inserted directly (superuser) so the test focuses on gate passes
INSERT INTO sales_invoices(id, tenant_id, organisation_id, invoice_number, invoice_date, customer_id, from_location, status, posted_at, posted_by)
VALUES ('00000000-0000-0000-0000-00000000a5a1', :T, :O, 'SI-1', CURRENT_DATE, '00000000-0000-0000-0000-00000000a0e2',
   '00000000-0000-0000-0000-00000000a0c1', 'POSTED', now(), :U),
       ('00000000-0000-0000-0000-00000000a5a2', :T, :O, 'SI-2-DRAFT', CURRENT_DATE, NULL,
   '00000000-0000-0000-0000-00000000a0c1', 'DRAFT', NULL, NULL);
INSERT INTO purchase_invoices(id, tenant_id, organisation_id, invoice_number, invoice_date, supplier_id, received_at_location, status, posted_at)
VALUES ('00000000-0000-0000-0000-00000000a6a1', :T, :O, 'PI-1', CURRENT_DATE, '00000000-0000-0000-0000-00000000a0e1',
   '00000000-0000-0000-0000-00000000a0c2', 'POSTED', now());
INSERT INTO credit_notes(id, tenant_id, organisation_id, credit_note_number, reason, original_invoice_id, goods_returned, return_to_location, status, posted_at, posted_by)
VALUES ('00000000-0000-0000-0000-00000000a7a1', :T, :O, 'CN-1', 'RETURN_OF_GOODS', '00000000-0000-0000-0000-00000000a5a1', true,
   '00000000-0000-0000-0000-00000000a0c2', 'POSTED', now(), :U),
       ('00000000-0000-0000-0000-00000000a7a2', :T, :O, 'CN-2-PRICE', 'PRICE_ADJUSTMENT', '00000000-0000-0000-0000-00000000a5a1', false,
   NULL, 'POSTED', now(), :U);
INSERT INTO delivery_challans(id, tenant_id, organisation_id, challan_number, purpose, status, from_location, delivery_address, place_of_supply_state)
VALUES ('00000000-0000-0000-0000-00000000a8a1', :T, :O, 'DC-1', 'SALE_ON_APPROVAL', 'DISPATCHED',
   '00000000-0000-0000-0000-00000000a0c1', 'Village road', 'Maharashtra'),
       ('00000000-0000-0000-0000-00000000a8a2', :T, :O, 'DC-2-DRAFT', 'SALE_ON_APPROVAL', 'DRAFT',
   '00000000-0000-0000-0000-00000000a0c1', 'Village road', 'Maharashtra');

-- a challan using the repaired columns (transporter FK now points at the transporters master)
INSERT INTO transporters(id, tenant_id, organisation_id, transporter_code, legal_name)
VALUES ('00000000-0000-0000-0000-00000000a4a1', :T, :O, 'TRN-1', 'Fast Movers Pvt Ltd');
INSERT INTO delivery_challans(id, tenant_id, organisation_id, challan_number, purpose, status, from_location, delivery_address,
   place_of_supply_state, transporter_id, consignee_name, consignee_gstin, driver_mobile, distance_km, bill_to_party_id, ship_to_party_id)
VALUES ('00000000-0000-0000-0000-00000000a8a3', :T, :O, 'DC-3', 'CF_DISPATCH', 'DISPATCHED', '00000000-0000-0000-0000-00000000a0c1',
   'Plot 5, MIDC', 'Maharashtra', '00000000-0000-0000-0000-00000000a4a1', 'Customer Y', '27AABCU9603R1ZX', '9876543210', 120.5,
   '00000000-0000-0000-0000-00000000a0e2', '00000000-0000-0000-0000-00000000a0e2');
INSERT INTO delivery_challan_items(tenant_id, challan_id, product_id, batch_id, unit_of_measure, qty, declared_unit_rate)
VALUES (:T, '00000000-0000-0000-0000-00000000a8a3', '00000000-0000-0000-0000-00000000a0d1', '00000000-0000-0000-0000-00000000a0b1', 'BAG', 5, 10);

SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', :U, false);

-- a real transfer, via the engine
INSERT INTO stock_transfers(id, tenant_id, organisation_id, transfer_no, source_location_id, destination_location_id)
VALUES ('00000000-0000-0000-0000-00000000a9a1', :T, :O, 'TR-1', '00000000-0000-0000-0000-00000000a0c1', '00000000-0000-0000-0000-00000000a0c2');
INSERT INTO stock_transfer_items(tenant_id, transfer_id, product_id, source_batch_id, unit_of_measure, requested_qty)
VALUES (:T, '00000000-0000-0000-0000-00000000a9a1', '00000000-0000-0000-0000-00000000a0d1', '00000000-0000-0000-0000-00000000a0b1', 'BAG', 40);

-- 1. TRANSFER PASSES ----------------------------------------------------------------------------
SELECT t_fails('no pass before the transfer is dispatched', $$SELECT t_gp('STOCK_TRANSFER', '00000000-0000-0000-0000-00000000a9a1', 'OUTWARD_TRANSFER')$$, 'not been dispatched');
SELECT rpc_dispatch_stock_transfer('00000000-0000-0000-0000-00000000a0a1', '00000000-0000-0000-0000-00000000a9a1', '00000000-0000-0000-0000-00000000a0a2');

SELECT t_eq('dispatched transfer is on the pending worklist (outward + inward)', (SELECT COUNT(*) FROM vw_gate_pass_pending WHERE reference_doc_no = 'TR-1'), 2);
SELECT t_gp('STOCK_TRANSFER', '00000000-0000-0000-0000-00000000a9a1', 'OUTWARD_TRANSFER');
SELECT t_eq('outward pass issued at the SOURCE location',
  (SELECT COUNT(*) FROM vw_gate_passes WHERE reference_doc_no = 'TR-1' AND pass_type = 'OUTWARD_TRANSFER' AND location_name = 'Godown A'), 1);
SELECT t_eq('numbering starts at 00001', (SELECT COUNT(*) FROM gate_passes WHERE gate_pass_no ~ '^GP-[0-9]{4}-00001$'), 1);
SELECT t_eq('outward pass leaves the worklist', (SELECT COUNT(*) FROM vw_gate_pass_pending WHERE reference_doc_no = 'TR-1' AND pass_type = 'OUTWARD_TRANSFER'), 0);
SELECT t_eq('inward still pending', (SELECT COUNT(*) FROM vw_gate_pass_pending WHERE reference_doc_no = 'TR-1' AND pass_type = 'INWARD_TRANSFER'), 1);
SELECT t_fails('one active pass per document and type', $$SELECT t_gp('STOCK_TRANSFER', '00000000-0000-0000-0000-00000000a9a1', 'OUTWARD_TRANSFER')$$, 'already exists');
SELECT t_gp('STOCK_TRANSFER', '00000000-0000-0000-0000-00000000a9a1', 'INWARD_TRANSFER');
SELECT t_eq('inward pass issued at the DESTINATION location',
  (SELECT COUNT(*) FROM vw_gate_passes WHERE reference_doc_no = 'TR-1' AND pass_type = 'INWARD_TRANSFER' AND location_name = 'Godown B'), 1);
SELECT t_fails('wrong pass type for the document', $$SELECT t_gp('STOCK_TRANSFER', '00000000-0000-0000-0000-00000000a9a1', 'OUTWARD_SALE')$$, 'cannot be issued against');

-- 2. DETAILS ARE VALIDATED / NORMALISED -----------------------------------------------------------
SELECT t_fails('short vehicle number rejected', $$SELECT t_gp('SALE_INVOICE', '00000000-0000-0000-0000-00000000a5a1', 'OUTWARD_SALE', 'AB1')$$, 'valid vehicle number');
SELECT t_fails('vehicle with symbols rejected', $$SELECT t_gp('SALE_INVOICE', '00000000-0000-0000-0000-00000000a5a1', 'OUTWARD_SALE', 'MH12@#1234')$$, 'valid vehicle number');
SELECT t_fails('bad driver mobile rejected', $$SELECT issue_gate_pass('SALE_INVOICE', '00000000-0000-0000-0000-00000000a5a1', 'OUTWARD_SALE', 'MH12AB1234', 'Raju', '12345')$$, '10-digit');
SELECT t_fails('negative packages rejected', $$SELECT issue_gate_pass('SALE_INVOICE', '00000000-0000-0000-0000-00000000a5a1', 'OUTWARD_SALE', 'MH12AB1234', NULL, NULL, -1)$$, 'cannot be negative');

-- 3. SALES / PURCHASE / CREDIT NOTE / CHALLAN -----------------------------------------------------
SELECT t_fails('draft invoice gets no pass', $$SELECT t_gp('SALE_INVOICE', '00000000-0000-0000-0000-00000000a5a2', 'OUTWARD_SALE')$$, 'not posted');
SELECT t_eq('posted invoice is pending a pass', (SELECT COUNT(*) FROM vw_gate_pass_pending WHERE reference_doc_no = 'SI-1'), 1);
SELECT issue_gate_pass('SALE_INVOICE', '00000000-0000-0000-0000-00000000a5a1', 'OUTWARD_SALE', 'mh 12-ab 1234', 'Raju', '+91 98765 43210', 25, 'Guard Singh', 'Loaded 25 bags');
SELECT t_eq('vehicle normalised to MH12AB1234', (SELECT COUNT(*) FROM gate_passes WHERE reference_doc_no = 'SI-1' AND vehicle_no = 'MH12AB1234'), 1);
SELECT t_eq('mobile normalised to 10 digits', (SELECT COUNT(*) FROM gate_passes WHERE reference_doc_no = 'SI-1' AND driver_mobile = '9876543210'), 1);
SELECT t_eq('sale pass at the invoice dispatch location', (SELECT COUNT(*) FROM vw_gate_passes WHERE reference_doc_no = 'SI-1' AND location_name = 'Godown A'), 1);
SELECT t_eq('sale no longer pending', (SELECT COUNT(*) FROM vw_gate_pass_pending WHERE reference_doc_no = 'SI-1'), 0);

SELECT t_gp('PURCHASE_INVOICE', '00000000-0000-0000-0000-00000000a6a1', 'INWARD_PURCHASE');
SELECT t_eq('purchase pass at the receiving location', (SELECT COUNT(*) FROM vw_gate_passes WHERE reference_doc_no = 'PI-1' AND location_name = 'Godown B'), 1);
SELECT t_gp('CREDIT_NOTE', '00000000-0000-0000-0000-00000000a7a1', 'INWARD_SALES_RETURN');
SELECT t_eq('return pass at the return location', (SELECT COUNT(*) FROM vw_gate_passes WHERE reference_doc_no = 'CN-1' AND location_name = 'Godown B'), 1);
SELECT t_fails('credit note without returned goods gets no pass', $$SELECT t_gp('CREDIT_NOTE', '00000000-0000-0000-0000-00000000a7a2', 'INWARD_SALES_RETURN')$$, 'does not involve returned goods');
SELECT t_gp('DELIVERY_CHALLAN', '00000000-0000-0000-0000-00000000a8a1', 'OUTWARD_SALE');
SELECT t_gp('DELIVERY_CHALLAN', '00000000-0000-0000-0000-00000000a8a3', 'OUTWARD_TRANSFER');
SELECT t_eq('challan with transporter + compliance fields can carry a pass', (SELECT COUNT(*) FROM gate_passes WHERE reference_doc_no = 'DC-3'), 1);
SELECT t_fails('draft challan gets no pass', $$SELECT t_gp('DELIVERY_CHALLAN', '00000000-0000-0000-0000-00000000a8a2', 'OUTWARD_SALE')$$, 'not been dispatched');

-- 4. VOID + RE-ISSUE ------------------------------------------------------------------------------
SELECT t_fails('void needs a reason', $$SELECT void_gate_pass((SELECT id FROM gate_passes WHERE reference_doc_no = 'PI-1'), ' ')$$, 'reason is required');
SELECT void_gate_pass((SELECT id FROM gate_passes WHERE reference_doc_no = 'PI-1'), 'Wrong vehicle recorded');
SELECT t_eq('voided pass is kept and flagged', (SELECT COUNT(*) FROM vw_gate_passes WHERE reference_doc_no = 'PI-1' AND is_voided AND void_reason = 'Wrong vehicle recorded'), 1);
SELECT t_eq('purchase is pending again after the void', (SELECT COUNT(*) FROM vw_gate_pass_pending WHERE reference_doc_no = 'PI-1'), 1);
SELECT t_fails('cannot void twice', $$SELECT void_gate_pass((SELECT id FROM gate_passes WHERE reference_doc_no = 'PI-1' LIMIT 1), 'again')$$, 'not found or already voided');
SELECT t_gp('PURCHASE_INVOICE', '00000000-0000-0000-0000-00000000a6a1', 'INWARD_PURCHASE', 'MH14CD5678');
SELECT t_eq('replacement issued with a new, higher number', (SELECT COUNT(*) FROM gate_passes WHERE reference_doc_no = 'PI-1' AND voided_at IS NULL AND vehicle_no = 'MH14CD5678'), 1);
SELECT t_eq('numbers are unique', (SELECT COUNT(DISTINCT gate_pass_no) - COUNT(*) FROM gate_passes), 0);

-- 5. IMMUTABLE / NOT FORGEABLE --------------------------------------------------------------------
SELECT t_fails('passes cannot be inserted by hand', $$INSERT INTO gate_passes(tenant_id, organisation_id, location_id, gate_pass_no, pass_type, reference_doc_type, reference_doc_id, reference_doc_no, vehicle_no)
   VALUES ('00000000-0000-0000-0000-00000000a0a1','00000000-0000-0000-0000-00000000a0a3','00000000-0000-0000-0000-00000000a0c1','GP-FAKE','OUTWARD_SALE','SALE_INVOICE',
   '00000000-0000-0000-0000-00000000a5a1','SI-1','MH12AB1234')$$, 'permission denied');
SELECT t_fails('passes cannot be edited', $$UPDATE gate_passes SET vehicle_no = 'XX00XX0000'$$, 'permission denied');
SELECT t_fails('passes cannot be deleted', $$DELETE FROM gate_passes$$, 'permission denied');

SELECT id AS gp_id FROM gate_passes WHERE reference_doc_no = 'SI-1' AND voided_at IS NULL \gset
-- 6. TENANT ISOLATION -----------------------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', :U2, false);
SELECT t_eq('other tenant sees no passes', (SELECT COUNT(*) FROM vw_gate_passes), 0);
SELECT t_eq('other tenant sees no pending worklist', (SELECT COUNT(*) FROM vw_gate_pass_pending), 0);
SELECT t_fails('other tenant cannot issue against our invoice', $$SELECT t_gp('SALE_INVOICE', '00000000-0000-0000-0000-00000000a5a1', 'OUTWARD_SALE')$$, 'not found');
SELECT t_fails('other tenant cannot void our pass', 'SELECT void_gate_pass(''' || :'gp_id' || ''', ''x'')', 'not found or already voided');

RESET ROLE;
DROP FUNCTION public.t_eq(text,numeric,numeric), public.t_fails(text,text,text), public.t_gp(text,uuid,gate_pass_type_enum,text);
\echo E2E PASSED
