-- ============================================================
-- Migration 045: Gate passes (recorded & linked to the real document)
-- FertiLedger ERP
-- ============================================================
-- A gate pass records a vehicle physically passing the gate with goods. It is NOT a
-- precondition for dispatch; it is issued against a document that already exists and
-- is in a valid state, so the security log always ties back to a real movement:
--
--   reference doc            pass type            document must be            location (derived)
--   STOCK_TRANSFER           OUTWARD_TRANSFER     IN_TRANSIT / RECEIVED       source location
--   STOCK_TRANSFER           INWARD_TRANSFER      IN_TRANSIT / RECEIVED       destination location
--   SALE_INVOICE             OUTWARD_SALE         POSTED                      invoice dispatch location
--   PURCHASE_INVOICE         INWARD_PURCHASE      POSTED                      receiving location
--   CREDIT_NOTE              INWARD_SALES_RETURN  POSTED, goods returned      return location
--   DELIVERY_CHALLAN         OUTWARD_SALE /       DISPATCHED / DELIVERED /    challan dispatch location
--                            OUTWARD_TRANSFER     INVOICED
-- Passes are immutable. A wrong pass is VOIDED (reason kept) and a new one issued.
-- One active pass per document and type. All writes go through the functions below.

ALTER TABLE gate_passes ADD COLUMN IF NOT EXISTS voided_at  timestamptz;
ALTER TABLE gate_passes ADD COLUMN IF NOT EXISTS voided_by  uuid REFERENCES auth.users(id);
ALTER TABLE gate_passes ADD COLUMN IF NOT EXISTS void_reason text;

CREATE UNIQUE INDEX IF NOT EXISTS uq_gate_pass_active_doc
  ON gate_passes (tenant_id, reference_doc_type, reference_doc_id, pass_type) WHERE voided_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_gate_passes_org_date ON gate_passes (organisation_id, pass_date DESC);

DROP POLICY IF EXISTS gate_passes_tenant_insert ON gate_passes;
REVOKE ALL ON gate_passes FROM anon, authenticated;
GRANT SELECT ON gate_passes TO authenticated;

-- ─── issue_gate_pass ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.issue_gate_pass(
  p_reference_type   text,
  p_reference_id     uuid,
  p_pass_type        gate_pass_type_enum,
  p_vehicle_no       text,
  p_driver_name      text DEFAULT NULL,
  p_driver_mobile    text DEFAULT NULL,
  p_total_packages   int  DEFAULT NULL,
  p_security_officer text DEFAULT NULL,
  p_remarks          text DEFAULT NULL
) RETURNS gate_passes
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_tenant  uuid := public.get_tenant_id();
  v_org     uuid;
  v_loc     uuid;
  v_no      text;
  v_status  text;
  v_veh     text;
  v_mob     text;
  v_exist   text;
  v_n       int;
  g         gate_passes%ROWTYPE;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;

  -- vehicle & driver details
  v_veh := upper(regexp_replace(btrim(COALESCE(p_vehicle_no, '')), '[\s\-]', '', 'g'));
  IF v_veh !~ '^[A-Z0-9]{6,12}$' THEN RAISE EXCEPTION 'Enter a valid vehicle number (e.g. MH12AB1234)'; END IF;
  IF COALESCE(btrim(p_driver_mobile), '') <> '' THEN
    v_mob := regexp_replace(p_driver_mobile, '\D', '', 'g');
    IF length(v_mob) = 12 AND left(v_mob, 2) = '91' THEN v_mob := right(v_mob, 10); END IF;
    IF v_mob !~ '^[0-9]{10}$' THEN RAISE EXCEPTION 'Driver mobile must be a 10-digit number'; END IF;
  END IF;
  IF p_total_packages IS NOT NULL AND p_total_packages < 0 THEN RAISE EXCEPTION 'Packages cannot be negative'; END IF;

  -- resolve the document, check its state, derive location
  IF p_reference_type = 'STOCK_TRANSFER' AND p_pass_type IN ('OUTWARD_TRANSFER', 'INWARD_TRANSFER') THEN
    SELECT organisation_id, status::text, transfer_no,
           CASE WHEN p_pass_type = 'OUTWARD_TRANSFER' THEN source_location_id ELSE destination_location_id END
      INTO v_org, v_status, v_no, v_loc
      FROM stock_transfers WHERE id = p_reference_id AND tenant_id = v_tenant;
    IF NOT FOUND THEN RAISE EXCEPTION 'Stock transfer not found'; END IF;
    IF v_status NOT IN ('IN_TRANSIT', 'RECEIVED') THEN
      RAISE EXCEPTION 'Transfer % has not been dispatched yet (status: %)', v_no, v_status;
    END IF;

  ELSIF p_reference_type = 'SALE_INVOICE' AND p_pass_type = 'OUTWARD_SALE' THEN
    SELECT organisation_id, status::text, invoice_number, from_location
      INTO v_org, v_status, v_no, v_loc FROM sales_invoices WHERE id = p_reference_id AND tenant_id = v_tenant;
    IF NOT FOUND THEN RAISE EXCEPTION 'Sales invoice not found'; END IF;
    IF v_status <> 'POSTED' THEN RAISE EXCEPTION 'Invoice % is not posted (status: %)', v_no, v_status; END IF;

  ELSIF p_reference_type = 'PURCHASE_INVOICE' AND p_pass_type = 'INWARD_PURCHASE' THEN
    SELECT organisation_id, status::text, invoice_number, received_at_location
      INTO v_org, v_status, v_no, v_loc FROM purchase_invoices WHERE id = p_reference_id AND tenant_id = v_tenant;
    IF NOT FOUND THEN RAISE EXCEPTION 'Purchase invoice not found'; END IF;
    IF v_status <> 'POSTED' THEN RAISE EXCEPTION 'Purchase invoice % is not posted (status: %)', v_no, v_status; END IF;

  ELSIF p_reference_type = 'CREDIT_NOTE' AND p_pass_type = 'INWARD_SALES_RETURN' THEN
    SELECT organisation_id, status, credit_note_number, return_to_location
      INTO v_org, v_status, v_no, v_loc FROM credit_notes WHERE id = p_reference_id AND tenant_id = v_tenant;
    IF NOT FOUND THEN RAISE EXCEPTION 'Credit note not found'; END IF;
    IF v_status <> 'POSTED' THEN RAISE EXCEPTION 'Credit note % is not posted (status: %)', v_no, v_status; END IF;
    IF NOT EXISTS (SELECT 1 FROM credit_notes WHERE id = p_reference_id AND goods_returned AND return_to_location IS NOT NULL) THEN
      RAISE EXCEPTION 'Credit note % does not involve returned goods', v_no;
    END IF;

  ELSIF p_reference_type = 'DELIVERY_CHALLAN' AND p_pass_type IN ('OUTWARD_SALE', 'OUTWARD_TRANSFER') THEN
    SELECT organisation_id, status::text, challan_number, from_location
      INTO v_org, v_status, v_no, v_loc FROM delivery_challans WHERE id = p_reference_id AND tenant_id = v_tenant;
    IF NOT FOUND THEN RAISE EXCEPTION 'Delivery challan not found'; END IF;
    IF v_status NOT IN ('DISPATCHED', 'DELIVERED', 'INVOICED') THEN
      RAISE EXCEPTION 'Challan % has not been dispatched (status: %)', v_no, v_status;
    END IF;

  ELSE
    RAISE EXCEPTION 'A % gate pass cannot be issued against a % document', p_pass_type, p_reference_type;
  END IF;

  IF v_loc IS NULL THEN RAISE EXCEPTION 'The document has no location to issue the pass at'; END IF;

  SELECT gate_pass_no INTO v_exist FROM gate_passes
   WHERE tenant_id = v_tenant AND reference_doc_type = p_reference_type AND reference_doc_id = p_reference_id
     AND pass_type = p_pass_type AND voided_at IS NULL;
  IF v_exist IS NOT NULL THEN
    RAISE EXCEPTION 'Gate pass % already exists for % % - void it first if it was issued in error', v_exist, p_reference_type, v_no;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('gate_pass:' || v_org::text, 0));
  SELECT COALESCE(MAX(NULLIF(regexp_replace(gate_pass_no, '^GP-\d{4}-', ''), '')::int), 0) + 1 INTO v_n
    FROM gate_passes WHERE tenant_id = v_tenant AND organisation_id = v_org
     AND gate_pass_no LIKE 'GP-' || to_char(CURRENT_DATE, 'YYYY') || '-%';

  INSERT INTO gate_passes (tenant_id, organisation_id, location_id, gate_pass_no, pass_type, reference_doc_type, reference_doc_id,
                           reference_doc_no, vehicle_no, driver_name, driver_mobile, total_packages, security_officer_name, remarks, created_by)
  VALUES (v_tenant, v_org, v_loc, 'GP-' || to_char(CURRENT_DATE, 'YYYY') || '-' || lpad(v_n::text, 5, '0'), p_pass_type,
          p_reference_type, p_reference_id, v_no, v_veh, NULLIF(btrim(p_driver_name), ''), v_mob, p_total_packages,
          NULLIF(btrim(p_security_officer), ''), NULLIF(btrim(p_remarks), ''), auth.uid())
  RETURNING * INTO g;
  RETURN g;
END $$;

-- ─── void_gate_pass ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.void_gate_pass(p_id uuid, p_reason text)
RETURNS gate_passes
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE g gate_passes%ROWTYPE;
BEGIN
  IF public.get_tenant_id() IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF COALESCE(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'A reason is required to void a gate pass'; END IF;
  UPDATE gate_passes SET voided_at = now(), voided_by = auth.uid(), void_reason = btrim(p_reason)
   WHERE id = p_id AND tenant_id = public.get_tenant_id() AND voided_at IS NULL
   RETURNING * INTO g;
  IF NOT FOUND THEN RAISE EXCEPTION 'Gate pass not found or already voided'; END IF;
  RETURN g;
END $$;

REVOKE ALL ON FUNCTION public.issue_gate_pass(text,uuid,gate_pass_type_enum,text,text,text,int,text,text),
  public.void_gate_pass(uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.issue_gate_pass(text,uuid,gate_pass_type_enum,text,text,text,int,text,text),
  public.void_gate_pass(uuid,text) TO authenticated;

-- ─── Views ────────────────────────────────────────────────────
CREATE OR REPLACE VIEW vw_gate_passes WITH (security_invoker = true) AS
SELECT g.*, l.name AS location_name, (g.voided_at IS NOT NULL) AS is_voided
  FROM gate_passes g JOIN locations l ON l.id = g.location_id;
GRANT SELECT ON vw_gate_passes TO authenticated;

-- Movements of the last 60 days that have no active gate pass yet (advisory worklist)
CREATE OR REPLACE VIEW vw_gate_pass_pending WITH (security_invoker = true) AS
SELECT * FROM (
  SELECT t.tenant_id, t.organisation_id, 'STOCK_TRANSFER'::text AS reference_doc_type, t.id AS reference_doc_id,
         t.transfer_no AS reference_doc_no, t.transfer_date AS doc_date, 'OUTWARD_TRANSFER'::text AS pass_type,
         t.source_location_id AS location_id, ls.name AS location_name, ld.name AS counterparty
    FROM stock_transfers t
    JOIN locations ls ON ls.id = t.source_location_id JOIN locations ld ON ld.id = t.destination_location_id
   WHERE t.status IN ('IN_TRANSIT', 'RECEIVED') AND t.transfer_date >= CURRENT_DATE - 60
  UNION ALL
  SELECT t.tenant_id, t.organisation_id, 'STOCK_TRANSFER', t.id, t.transfer_no, t.transfer_date, 'INWARD_TRANSFER',
         t.destination_location_id, ld.name, ls.name
    FROM stock_transfers t
    JOIN locations ls ON ls.id = t.source_location_id JOIN locations ld ON ld.id = t.destination_location_id
   WHERE t.status IN ('IN_TRANSIT', 'RECEIVED') AND t.transfer_date >= CURRENT_DATE - 60
  UNION ALL
  SELECT s.tenant_id, s.organisation_id, 'SALE_INVOICE', s.id, s.invoice_number, s.invoice_date, 'OUTWARD_SALE',
         s.from_location, l.name, COALESCE(p.name, s.customer_name)
    FROM sales_invoices s JOIN locations l ON l.id = s.from_location LEFT JOIN parties p ON p.id = s.customer_id
   WHERE s.status = 'POSTED' AND s.invoice_date >= CURRENT_DATE - 60
  UNION ALL
  SELECT i.tenant_id, i.organisation_id, 'PURCHASE_INVOICE', i.id, i.invoice_number, i.invoice_date, 'INWARD_PURCHASE',
         i.received_at_location, l.name, p.name
    FROM purchase_invoices i JOIN locations l ON l.id = i.received_at_location LEFT JOIN parties p ON p.id = i.supplier_id
   WHERE i.status = 'POSTED' AND i.invoice_date >= CURRENT_DATE - 60
) d
WHERE NOT EXISTS (
  SELECT 1 FROM gate_passes g
   WHERE g.tenant_id = d.tenant_id AND g.reference_doc_type = d.reference_doc_type
     AND g.reference_doc_id = d.reference_doc_id AND g.pass_type::text = d.pass_type AND g.voided_at IS NULL);
GRANT SELECT ON vw_gate_pass_pending TO authenticated;
