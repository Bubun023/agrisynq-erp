-- ============================================================
-- Migration 042: FMS portal data import & matching
-- FertiLedger ERP
-- ============================================================
-- A user uploads the transaction file downloaded from the FMS/iFMS portal.
-- import_fms_data() stores every line and matches it to farmer_sales by PoS
-- transaction id (case/space-insensitive, same normalisation as the unique index
-- in 040), in one transaction. Line outcomes:
--   MATCHED              portal and system agree (qty within 0.001, subsidy within 0.01)
--   QTY_MISMATCH         quantities differ (note also lists a subsidy difference)
--   SUBSIDY_MISMATCH     subsidy differs
--   MISSING_IN_SYSTEM    portal has a transaction we have no sale for
--   CANCELLED_IN_SYSTEM  we cancelled the sale but the portal still holds the transaction
--                        (the dealer must reverse it on the portal)
--   NOT_POSTED           sale exists but is not posted yet
--   DUPLICATE_IN_FILE    same PoS id appears more than once in the upload
--   INVALID              line has no PoS id
-- Sales in the period with no portal line are reported by fms_import_missing_in_portal().
-- Matched sales get fms_synced_at / fms_acknowledgement_no stamped.

CREATE TABLE IF NOT EXISTS fms_import_batches (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id),
  organisation_id      uuid NOT NULL REFERENCES organisations(id),
  filename             text,
  fms_dealer_id        text NOT NULL,
  period_from          date NOT NULL,
  period_to            date NOT NULL,
  total_lines          int NOT NULL DEFAULT 0,
  matched              int NOT NULL DEFAULT 0,
  mismatched           int NOT NULL DEFAULT 0,
  missing_in_system    int NOT NULL DEFAULT 0,
  cancelled_in_system  int NOT NULL DEFAULT 0,
  not_posted           int NOT NULL DEFAULT 0,
  duplicate_in_file    int NOT NULL DEFAULT 0,
  invalid_lines        int NOT NULL DEFAULT 0,
  missing_in_portal    int NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid REFERENCES auth.users(id),
  CHECK (period_to >= period_from)
);

CREATE TABLE IF NOT EXISTS fms_import_lines (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  batch_id            uuid NOT NULL REFERENCES fms_import_batches(id) ON DELETE CASCADE,
  line_no             int NOT NULL,
  pos_transaction_id  text,
  txn_date            date,
  farmer_name         text,
  fms_product_code    text,
  qty                 numeric(15,3),
  subsidy_amount      numeric(15,2),
  ack_no              text,
  match_status        text NOT NULL,
  matched_sale_id     uuid REFERENCES farmer_sales(id),
  system_qty          numeric(15,3),
  system_subsidy      numeric(15,2),
  note                text
);
CREATE INDEX IF NOT EXISTS idx_fms_import_lines_batch  ON fms_import_lines(batch_id, match_status);
CREATE INDEX IF NOT EXISTS idx_fms_import_batches_org  ON fms_import_batches(organisation_id, created_at DESC);

ALTER TABLE fms_import_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE fms_import_lines   ENABLE ROW LEVEL SECURITY;
CREATE POLICY fib_select ON fms_import_batches FOR SELECT USING (tenant_id = public.get_tenant_id());
CREATE POLICY fil_select ON fms_import_lines   FOR SELECT USING (tenant_id = public.get_tenant_id());
-- writes happen only through import_fms_data() (SECURITY DEFINER); imports are never edited or deleted by users

-- ─── import_fms_data ──────────────────────────────────────────
-- p_lines: [{"pos_id":"..","date":"YYYY-MM-DD","farmer":"..","product_code":"..","qty":n,"subsidy":n,"ack":".."}]
CREATE OR REPLACE FUNCTION public.import_fms_data(
  p_organisation_id uuid,
  p_filename        text,
  p_dealer_id       text,
  p_period_from     date,
  p_period_to       date,
  p_lines           jsonb
) RETURNS fms_import_batches
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_tenant uuid := public.get_tenant_id();
  b        fms_import_batches%ROWTYPE;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT EXISTS (SELECT 1 FROM organisations WHERE id = p_organisation_id AND tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'Organisation not found';
  END IF;
  IF COALESCE(btrim(p_dealer_id), '') = '' THEN RAISE EXCEPTION 'FMS dealer ID is required'; END IF;
  IF p_period_to < p_period_from THEN RAISE EXCEPTION 'Period end is before period start'; END IF;
  IF jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'The file contains no transactions';
  END IF;
  IF jsonb_array_length(p_lines) > 20000 THEN RAISE EXCEPTION 'Too many lines (max 20000 per import)'; END IF;

  INSERT INTO fms_import_batches (tenant_id, organisation_id, filename, fms_dealer_id, period_from, period_to, created_by)
  VALUES (v_tenant, p_organisation_id, p_filename, btrim(p_dealer_id), p_period_from, p_period_to, auth.uid())
  RETURNING * INTO b;

  -- 1. store lines (status decided below)
  INSERT INTO fms_import_lines (tenant_id, batch_id, line_no, pos_transaction_id, txn_date, farmer_name,
                                fms_product_code, qty, subsidy_amount, ack_no, match_status)
  SELECT v_tenant, b.id, t.ord::int,
         NULLIF(btrim(t.e->>'pos_id'), ''),
         NULLIF(t.e->>'date', '')::date,
         NULLIF(btrim(t.e->>'farmer'), ''),
         NULLIF(btrim(t.e->>'product_code'), ''),
         NULLIF(t.e->>'qty', '')::numeric,
         NULLIF(t.e->>'subsidy', '')::numeric,
         NULLIF(btrim(t.e->>'ack'), ''),
         'UNMATCHED'
    FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS t(e, ord);

  -- 2. invalid + duplicates within the file
  UPDATE fms_import_lines SET match_status = 'INVALID', note = 'No PoS transaction id'
   WHERE batch_id = b.id AND pos_transaction_id IS NULL;

  UPDATE fms_import_lines l SET match_status = 'DUPLICATE_IN_FILE',
         note = 'PoS id appears more than once in this file (first occurrence is kept)'
    FROM (SELECT id, row_number() OVER (PARTITION BY upper(pos_transaction_id) ORDER BY line_no) AS rn
            FROM fms_import_lines WHERE batch_id = b.id AND pos_transaction_id IS NOT NULL) d
   WHERE l.id = d.id AND d.rn > 1;

  -- 3. match the rest against farmer sales
  UPDATE fms_import_lines l SET
         matched_sale_id = s.id,
         system_qty      = s.qty_sold,
         system_subsidy  = s.total_subsidy_amount,
         match_status = CASE
           WHEN s.status = 'CANCELLED'                                   THEN 'CANCELLED_IN_SYSTEM'
           WHEN s.status IN ('DRAFT', 'POS_PENDING', 'POS_RECORDED')    THEN 'NOT_POSTED'
           WHEN abs(COALESCE(l.qty, 0) - s.qty_sold) > 0.001             THEN 'QTY_MISMATCH'
           WHEN abs(COALESCE(l.subsidy_amount, 0) - s.total_subsidy_amount) > 0.01 THEN 'SUBSIDY_MISMATCH'
           ELSE 'MATCHED' END,
         note = CASE
           WHEN s.status = 'CANCELLED' THEN 'Cancelled in the system - reverse this transaction on the FMS portal'
           WHEN s.status IN ('DRAFT', 'POS_PENDING', 'POS_RECORDED') THEN 'Sale exists but is not posted yet'
           WHEN abs(COALESCE(l.qty, 0) - s.qty_sold) > 0.001 AND abs(COALESCE(l.subsidy_amount, 0) - s.total_subsidy_amount) > 0.01
             THEN 'Quantity ' || COALESCE(l.qty, 0) || ' vs ' || s.qty_sold || ' and subsidy ' || COALESCE(l.subsidy_amount, 0) || ' vs ' || s.total_subsidy_amount
           WHEN abs(COALESCE(l.qty, 0) - s.qty_sold) > 0.001 THEN 'Quantity ' || COALESCE(l.qty, 0) || ' (portal) vs ' || s.qty_sold || ' (system)'
           WHEN abs(COALESCE(l.subsidy_amount, 0) - s.total_subsidy_amount) > 0.01 THEN 'Subsidy ' || COALESCE(l.subsidy_amount, 0) || ' (portal) vs ' || s.total_subsidy_amount || ' (system)'
           ELSE NULL END
    FROM farmer_sales s
   WHERE l.batch_id = b.id AND l.match_status = 'UNMATCHED'
     AND s.tenant_id = v_tenant AND s.organisation_id = p_organisation_id
     AND upper(btrim(s.pos_transaction_id)) = upper(l.pos_transaction_id);

  UPDATE fms_import_lines SET match_status = 'MISSING_IN_SYSTEM', note = 'No sale with this PoS id in the system'
   WHERE batch_id = b.id AND match_status = 'UNMATCHED';

  -- 4. stamp matched sales as synced with the portal
  UPDATE farmer_sales s SET fms_synced_at = now(),
         fms_acknowledgement_no = COALESCE(l.ack_no, s.fms_acknowledgement_no)
    FROM fms_import_lines l
   WHERE l.batch_id = b.id AND l.match_status = 'MATCHED' AND s.id = l.matched_sale_id;

  -- 5. counts
  UPDATE fms_import_batches SET
    total_lines         = (SELECT COUNT(*) FROM fms_import_lines WHERE batch_id = b.id),
    matched             = (SELECT COUNT(*) FROM fms_import_lines WHERE batch_id = b.id AND match_status = 'MATCHED'),
    mismatched          = (SELECT COUNT(*) FROM fms_import_lines WHERE batch_id = b.id AND match_status IN ('QTY_MISMATCH', 'SUBSIDY_MISMATCH')),
    missing_in_system   = (SELECT COUNT(*) FROM fms_import_lines WHERE batch_id = b.id AND match_status = 'MISSING_IN_SYSTEM'),
    cancelled_in_system = (SELECT COUNT(*) FROM fms_import_lines WHERE batch_id = b.id AND match_status = 'CANCELLED_IN_SYSTEM'),
    not_posted          = (SELECT COUNT(*) FROM fms_import_lines WHERE batch_id = b.id AND match_status = 'NOT_POSTED'),
    duplicate_in_file   = (SELECT COUNT(*) FROM fms_import_lines WHERE batch_id = b.id AND match_status = 'DUPLICATE_IN_FILE'),
    invalid_lines       = (SELECT COUNT(*) FROM fms_import_lines WHERE batch_id = b.id AND match_status = 'INVALID'),
    missing_in_portal   = (SELECT COUNT(*) FROM farmer_sales s
                            WHERE s.tenant_id = v_tenant AND s.organisation_id = p_organisation_id
                              AND s.fms_dealer_id = btrim(p_dealer_id)
                              AND s.sale_date BETWEEN p_period_from AND p_period_to
                              AND s.status IN ('POSTED', 'SUBSIDY_CLAIMED', 'SUBSIDY_RECEIVED')
                              AND NOT EXISTS (SELECT 1 FROM fms_import_lines x WHERE x.batch_id = b.id
                                               AND x.matched_sale_id = s.id))
   WHERE id = b.id RETURNING * INTO b;
  RETURN b;
END $$;

-- ─── Sales that the portal file does not contain ──────────────
CREATE OR REPLACE FUNCTION public.fms_import_missing_in_portal(p_batch_id uuid)
RETURNS TABLE (sale_id uuid, sale_number text, sale_date date, farmer_name text,
               pos_transaction_id text, qty_sold numeric, total_subsidy_amount numeric, status text)
LANGUAGE sql STABLE AS $$
  SELECT s.id, s.sale_number, s.sale_date, s.farmer_name, s.pos_transaction_id, s.qty_sold,
         s.total_subsidy_amount, s.status::text
    FROM fms_import_batches b
    JOIN farmer_sales s ON s.tenant_id = b.tenant_id AND s.organisation_id = b.organisation_id
   WHERE b.id = p_batch_id AND b.tenant_id = public.get_tenant_id()
     AND s.fms_dealer_id = b.fms_dealer_id
     AND s.sale_date BETWEEN b.period_from AND b.period_to
     AND s.status IN ('POSTED', 'SUBSIDY_CLAIMED', 'SUBSIDY_RECEIVED')
     AND NOT EXISTS (SELECT 1 FROM fms_import_lines x WHERE x.batch_id = b.id AND x.matched_sale_id = s.id)
   ORDER BY s.sale_date, s.sale_number
$$;

REVOKE ALL ON FUNCTION public.import_fms_data(uuid,text,text,date,date,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.import_fms_data(uuid,text,text,date,date,jsonb),
                          public.fms_import_missing_in_portal(uuid) TO authenticated;
-- read-only for users even if a policy is ever added by mistake (default privileges grant ALL)
REVOKE ALL ON fms_import_batches, fms_import_lines FROM anon, authenticated;
GRANT SELECT ON fms_import_batches, fms_import_lines TO authenticated;
