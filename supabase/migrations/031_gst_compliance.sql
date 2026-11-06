-- ============================================================
-- Migration 031: GST Compliance Engine
-- Phase 8 - Sales Register, Purchase Register,
--            GSTR-1 Builder, GSTR-3B Summary, GSTR-2B Recon
-- ============================================================

-- ============================================================
-- A. GST Return Periods
-- ============================================================
CREATE TABLE IF NOT EXISTS gst_return_periods (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  organisation_id            UUID NOT NULL REFERENCES organisations(id),
  gstin             TEXT NOT NULL,
  return_period     TEXT NOT NULL,
  return_type       TEXT NOT NULL CHECK (return_type IN ('GSTR1','GSTR3B','GSTR2B')),
  status            TEXT NOT NULL DEFAULT 'OPEN'
                      CHECK (status IN ('OPEN','SAVED','SUBMITTED','FILED')),
  due_date          DATE,
  filed_at          TIMESTAMPTZ,
  reference_arn     TEXT,
  filed_by          UUID REFERENCES auth.users(id),
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, gstin, return_period, return_type)
);
ALTER TABLE gst_return_periods ENABLE ROW LEVEL SECURITY;
CREATE POLICY gst_return_periods_org ON gst_return_periods
  FOR ALL USING (tenant_id = public.get_tenant_id())
  WITH CHECK (tenant_id = public.get_tenant_id());

-- ============================================================
-- B. GSTR-2B Import
-- ============================================================
CREATE TABLE IF NOT EXISTS gstr2b_imports (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  organisation_id           UUID NOT NULL REFERENCES organisations(id),
  return_period    TEXT NOT NULL,
  gstin            TEXT NOT NULL,
  imported_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  imported_by      UUID REFERENCES auth.users(id),
  total_invoices   INT DEFAULT 0,
  total_itc_igst   NUMERIC(15,2) DEFAULT 0,
  total_itc_cgst   NUMERIC(15,2) DEFAULT 0,
  total_itc_sgst   NUMERIC(15,2) DEFAULT 0,
  raw_json         JSONB,
  status           TEXT NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING','RECONCILED'))
);
ALTER TABLE gstr2b_imports ENABLE ROW LEVEL SECURITY;
CREATE POLICY gstr2b_imports_org ON gstr2b_imports
  FOR ALL USING (tenant_id = public.get_tenant_id())
  WITH CHECK (tenant_id = public.get_tenant_id());

-- ============================================================
-- C. GSTR-2B Line Items
-- ============================================================
CREATE TABLE IF NOT EXISTS gstr2b_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id),
  import_id         UUID NOT NULL REFERENCES gstr2b_imports(id) ON DELETE CASCADE,
  organisation_id            UUID NOT NULL REFERENCES organisations(id),
  return_period     TEXT NOT NULL,
  supplier_gstin    TEXT NOT NULL,
  supplier_name     TEXT,
  invoice_number    TEXT NOT NULL,
  invoice_date      DATE NOT NULL,
  invoice_type      TEXT,
  place_of_supply   TEXT,
  irn               TEXT,
  taxable_value     NUMERIC(15,2) DEFAULT 0,
  igst_amount       NUMERIC(15,2) DEFAULT 0,
  cgst_amount       NUMERIC(15,2) DEFAULT 0,
  sgst_amount       NUMERIC(15,2) DEFAULT 0,
  cess_amount       NUMERIC(15,2) DEFAULT 0,
  total_itc         NUMERIC(15,2) GENERATED ALWAYS AS
                      (igst_amount + cgst_amount + sgst_amount) STORED,
  itc_availability  TEXT DEFAULT 'YES'
                      CHECK (itc_availability IN ('YES','NO','PROVISIONAL')),
  recon_status      TEXT NOT NULL DEFAULT 'UNMATCHED'
                      CHECK (recon_status IN ('MATCHED','UNMATCHED','MISMATCH','MISSING_IN_BOOKS')),
  matched_invoice_id UUID,
  mismatch_notes    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE gstr2b_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY gstr2b_items_org ON gstr2b_items
  FOR ALL USING (tenant_id = public.get_tenant_id())
  WITH CHECK (tenant_id = public.get_tenant_id());
CREATE INDEX IF NOT EXISTS idx_gstr2b_items_period   ON gstr2b_items(organisation_id, return_period);
CREATE INDEX IF NOT EXISTS idx_gstr2b_items_supplier ON gstr2b_items(supplier_gstin);

-- ============================================================
-- D. View: GST Sales Register
-- ============================================================
CREATE OR REPLACE VIEW vw_gst_sales_register WITH (security_invoker = true) AS
SELECT
  si.id,
  si.organisation_id,
  si.invoice_number,
  si.invoice_date,
  to_char(si.invoice_date, 'MMYYYY')  AS return_period,
  si.invoice_type,
  si.sale_type,
  si.status,
  p.name                               AS customer_name,
  si.customer_gstin,
  si.customer_state_code               AS buyer_state_code,
  si.place_of_supply,
  si.is_interstate,
  si.is_reverse_charge,
  si.taxable_amount,
  si.cgst_amount,
  si.sgst_amount,
  si.igst_amount,
  si.cess_amount,
  si.total_gst_amount,
  si.net_receivable,
  si.irn,
  NULL::text                           AS irn_status,  -- e-invoice status not tracked yet
  si.eway_bill_number                  AS eway_bill_no,
  CASE
    WHEN si.invoice_type = 'EXPORT'         THEN 'EXP'
    WHEN si.invoice_type = 'SEZ'            THEN 'SEZ'
    WHEN si.invoice_type = 'B2C_SMALL'      THEN 'B2CS'
    WHEN si.is_reverse_charge = TRUE          THEN 'B2B_RCM'
    WHEN si.net_receivable > 250000
     AND si.invoice_type = 'B2C_LARGE'      THEN 'B2CL'
    WHEN si.customer_gstin IS NOT NULL
     AND si.customer_gstin <> ''            THEN 'B2B'
    ELSE 'B2CS'
  END                                          AS gstr1_section,
  si.created_at,
  si.posted_at
FROM sales_invoices si
LEFT JOIN parties p ON p.id = si.customer_id
WHERE si.status = 'POSTED';

-- ============================================================
-- E. View: GST Purchase Register
-- ============================================================
CREATE OR REPLACE VIEW vw_gst_purchase_register WITH (security_invoker = true) AS
SELECT
  pi.id,
  pi.organisation_id,
  pi.invoice_number,
  pi.invoice_date,
  to_char(pi.invoice_date, 'MMYYYY') AS return_period,
  CASE WHEN pi.is_import THEN 'IMPORT' WHEN pi.is_reverse_charge THEN 'RCM' ELSE 'REGULAR' END AS invoice_type,
  pi.supplier_invoice_no,
  pi.status,
  p.name                              AS supplier_name,
  pi.supplier_gstin,
  pi.place_of_supply,
  pi.is_interstate,
  pi.is_reverse_charge,
  pi.taxable_amount,
  pi.cgst_amount,
  pi.sgst_amount,
  pi.igst_amount,
  pi.cess_amount,
  pi.total_gst_amount,
  pi.net_payable                      AS total_payable,
  -- ITC: full tax on a posted purchase invoice is treated as claimable (no reversal tracking yet)
  pi.cgst_amount                      AS itc_cgst,
  pi.sgst_amount                      AS itc_sgst,
  pi.igst_amount                      AS itc_igst,
  pi.cess_amount                      AS itc_cess,
  (COALESCE(pi.cgst_amount,0) + COALESCE(pi.sgst_amount,0)
   + COALESCE(pi.igst_amount,0) + COALESCE(pi.cess_amount,0)) AS total_itc_claimed,
  NULL::text                          AS itc_reversal_reason,
  pi.created_at,
  pi.posted_at
FROM purchase_invoices pi
LEFT JOIN parties p ON p.id = pi.supplier_id
WHERE pi.status = 'POSTED';

-- ============================================================
-- F. View: GSTR-3B Summary
-- ============================================================
CREATE OR REPLACE VIEW vw_gstr3b_summary WITH (security_invoker = true) AS
WITH sales AS (
  SELECT
    organisation_id,
    return_period,
    SUM(taxable_amount)   AS total_taxable_sales,
    SUM(cgst_amount)      AS total_cgst_sales,
    SUM(sgst_amount)      AS total_sgst_sales,
    SUM(igst_amount)      AS total_igst_sales,
    SUM(cess_amount)      AS total_cess_sales,
    SUM(CASE WHEN invoice_type = 'EXPORT' THEN net_receivable ELSE 0 END) AS export_value,
    SUM(CASE WHEN gstr1_section = 'B2B_RCM' THEN taxable_amount ELSE 0 END) AS rcm_outward_taxable
  FROM vw_gst_sales_register
  GROUP BY organisation_id, return_period
),
purchases AS (
  SELECT
    organisation_id,
    return_period,
    SUM(total_itc_claimed)  AS total_itc_available,
    SUM(itc_cgst)           AS itc_cgst,
    SUM(itc_sgst)           AS itc_sgst,
    SUM(itc_igst)           AS itc_igst,
    SUM(itc_cess)           AS itc_cess,
    SUM(CASE WHEN is_reverse_charge THEN taxable_amount ELSE 0 END) AS rcm_inward_taxable,
    SUM(CASE WHEN is_reverse_charge THEN total_gst_amount ELSE 0 END) AS rcm_tax_payable
  FROM vw_gst_purchase_register
  GROUP BY organisation_id, return_period
)
SELECT
  COALESCE(s.organisation_id, p.organisation_id)               AS organisation_id,
  COALESCE(s.return_period, p.return_period)  AS return_period,
  COALESCE(s.total_taxable_sales, 0)          AS taxable_sales,
  COALESCE(s.total_cgst_sales, 0)             AS cgst_on_sales,
  COALESCE(s.total_sgst_sales, 0)             AS sgst_on_sales,
  COALESCE(s.total_igst_sales, 0)             AS igst_on_sales,
  COALESCE(s.total_cess_sales, 0)             AS cess_on_sales,
  COALESCE(s.export_value, 0)                 AS export_value,
  COALESCE(p.rcm_inward_taxable, 0)           AS rcm_inward_taxable,
  COALESCE(p.rcm_tax_payable, 0)              AS rcm_tax_payable,
  COALESCE(p.itc_igst, 0)                     AS itc_igst,
  COALESCE(p.itc_cgst, 0)                     AS itc_cgst,
  COALESCE(p.itc_sgst, 0)                     AS itc_sgst,
  COALESCE(p.itc_cess, 0)                     AS itc_cess,
  COALESCE(p.total_itc_available, 0)          AS total_itc,
  GREATEST(0,
    COALESCE(s.total_cgst_sales,0)
    - COALESCE(p.itc_cgst,0))                 AS net_cgst_payable,
  GREATEST(0,
    COALESCE(s.total_sgst_sales,0)
    - COALESCE(p.itc_sgst,0))                 AS net_sgst_payable,
  GREATEST(0,
    COALESCE(s.total_igst_sales,0)
    - COALESCE(p.itc_igst,0))                 AS net_igst_payable
FROM sales s
FULL OUTER JOIN purchases p
  ON s.organisation_id = p.organisation_id AND s.return_period = p.return_period;

-- ============================================================
-- G. RPC: reconcile_gstr2b
-- ============================================================
CREATE OR REPLACE FUNCTION reconcile_gstr2b(p_import_id UUID)
RETURNS TABLE(matched INT, mismatched INT, unmatched INT)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_organisation_id UUID;
  v_tenant_id UUID;
  v_period TEXT;
BEGIN
  SELECT organisation_id, tenant_id, return_period INTO v_organisation_id, v_tenant_id, v_period
  FROM gstr2b_imports WHERE id = p_import_id AND tenant_id = public.get_tenant_id();
  IF v_organisation_id IS NULL THEN
    RAISE EXCEPTION 'GSTR-2B import not found';
  END IF;

  UPDATE gstr2b_items gi
  SET
    recon_status       = CASE
                           WHEN ABS(gi.taxable_value - pi.taxable_amount) < 1
                            AND ABS(gi.igst_amount   - pi.igst_amount) < 1
                            AND ABS(gi.cgst_amount   - pi.cgst_amount) < 1
                            AND ABS(gi.sgst_amount   - pi.sgst_amount) < 1
                           THEN 'MATCHED'
                           ELSE 'MISMATCH'
                         END,
    matched_invoice_id = pi.id,
    mismatch_notes     = CASE
                           WHEN ABS(gi.taxable_value - pi.taxable_amount) >= 1
                           THEN 'Taxable value differs by Rs.' || ROUND(ABS(gi.taxable_value - pi.taxable_amount),2)::TEXT
                           WHEN ABS(gi.igst_amount - pi.igst_amount) >= 1
                           THEN 'IGST differs by Rs.' || ROUND(ABS(gi.igst_amount - pi.igst_amount),2)::TEXT
                           WHEN ABS(gi.cgst_amount - pi.cgst_amount) >= 1
                           THEN 'CGST/SGST differs'
                           ELSE NULL
                         END
  FROM purchase_invoices pi
  WHERE gi.import_id = p_import_id
    AND gi.organisation_id = v_organisation_id
    AND pi.organisation_id = v_organisation_id
    AND pi.tenant_id = v_tenant_id
    AND UPPER(pi.supplier_gstin) = UPPER(gi.supplier_gstin)
    AND UPPER(TRIM(pi.supplier_invoice_no)) = UPPER(TRIM(gi.invoice_number))
    AND pi.status = 'POSTED';

  UPDATE gstr2b_items
  SET recon_status = 'MISSING_IN_BOOKS'
  WHERE import_id = p_import_id
    AND recon_status = 'UNMATCHED';

  UPDATE gstr2b_imports SET status = 'RECONCILED' WHERE id = p_import_id;

  RETURN QUERY
  SELECT
    (SELECT COUNT(*)::INT FROM gstr2b_items WHERE import_id=p_import_id AND recon_status='MATCHED'),
    (SELECT COUNT(*)::INT FROM gstr2b_items WHERE import_id=p_import_id AND recon_status='MISMATCH'),
    (SELECT COUNT(*)::INT FROM gstr2b_items WHERE import_id=p_import_id AND recon_status IN ('UNMATCHED','MISSING_IN_BOOKS'));
END;
$$;

-- ============================================================
-- H. Indexes
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_gst_return_periods_org
  ON gst_return_periods(organisation_id, return_period, return_type);
CREATE INDEX IF NOT EXISTS idx_gstr2b_imports_period
  ON gstr2b_imports(organisation_id, return_period);
