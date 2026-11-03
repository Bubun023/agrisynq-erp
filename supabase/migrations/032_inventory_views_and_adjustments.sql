-- ============================================================
-- Migration 032: Inventory Views & Stock Adjustments
-- Phase 9 — FertiLedger ERP
-- ============================================================

-- ─── Stock Adjustment Reasons Enum ───────────────────────────
DO $$ BEGIN
  CREATE TYPE stock_adjustment_reason AS ENUM (
    'DAMAGE',
    'EXPIRY',
    'THEFT',
    'RECOUNT',
    'SAMPLE',
    'TRANSFER_IN',
    'TRANSFER_OUT',
    'OTHER'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── Stock Adjustments Table ──────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_adjustments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id  uuid NOT NULL REFERENCES organisations(id),
  branch_id        uuid REFERENCES branches(id),
  adjustment_no    text NOT NULL,
  adjustment_date  date NOT NULL DEFAULT CURRENT_DATE,
  product_id       uuid NOT NULL REFERENCES products(id),
  batch_id         uuid REFERENCES inventory_batches(id),
  location_id      uuid REFERENCES locations(id),
  reason           stock_adjustment_reason NOT NULL DEFAULT 'RECOUNT',
  qty_before       numeric(14,3) NOT NULL DEFAULT 0,
  qty_adjustment   numeric(14,3) NOT NULL,   -- positive = increase, negative = decrease
  qty_after        numeric(14,3) NOT NULL,
  uom_id           uuid REFERENCES units_of_measure(id),
  notes            text,
  created_by       uuid REFERENCES auth.users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Auto-number trigger for adjustment_no
CREATE OR REPLACE FUNCTION generate_adjustment_no()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  v_seq int;
BEGIN
  SELECT COALESCE(MAX(CAST(SUBSTRING(adjustment_no FROM 'ADJ-(\d+)') AS int)), 0) + 1
    INTO v_seq
    FROM stock_adjustments
   WHERE organisation_id = NEW.organisation_id;
  NEW.adjustment_no := 'ADJ-' || LPAD(v_seq::text, 5, '0');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_adjustment_no ON stock_adjustments;
CREATE TRIGGER trg_adjustment_no
  BEFORE INSERT ON stock_adjustments
  FOR EACH ROW WHEN (NEW.adjustment_no = '' OR NEW.adjustment_no IS NULL)
  EXECUTE FUNCTION generate_adjustment_no();

-- Updated at trigger
CREATE TRIGGER trg_stock_adjustments_updated_at
  BEFORE UPDATE ON stock_adjustments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ─── RLS ─────────────────────────────────────────────────────
ALTER TABLE stock_adjustments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org_isolation_stock_adjustments" ON stock_adjustments
  USING (organisation_id = (SELECT organisation_id FROM user_profiles WHERE id = auth.uid()));

-- ─── Indexes ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_stock_adj_org       ON stock_adjustments(organisation_id);
CREATE INDEX IF NOT EXISTS idx_stock_adj_product   ON stock_adjustments(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_adj_date      ON stock_adjustments(adjustment_date DESC);
CREATE INDEX IF NOT EXISTS idx_stock_adj_batch     ON stock_adjustments(batch_id);

-- ─── View: vw_stock_ledger ────────────────────────────────────
-- Unified ledger: GRN receipts, sales issue, transfer in/out, adjustments
CREATE OR REPLACE VIEW vw_stock_ledger AS
WITH ledger_rows AS (

  -- GRN Receipts
  SELECT
    gi.organisation_id,
    gi.product_id,
    gi.batch_id,
    gi.location_id,
    gr.grn_date                   AS txn_date,
    'GRN'                         AS txn_type,
    gr.grn_no                     AS txn_ref,
    gr.id                         AS txn_id,
    gi.accepted_qty               AS qty_in,
    0::numeric                    AS qty_out,
    gi.unit_cost                  AS rate,
    NULL::text                    AS notes
  FROM grn_items gi
  JOIN goods_receipt_notes gr ON gr.id = gi.grn_id
  WHERE gr.status = 'POSTED'

  UNION ALL

  -- Sales Invoice Issues
  SELECT
    si.organisation_id,
    sil.product_id,
    sil.batch_id,
    NULL::uuid                    AS location_id,
    si.invoice_date               AS txn_date,
    'SALE'                        AS txn_type,
    si.invoice_no                 AS txn_ref,
    si.id                         AS txn_id,
    0::numeric                    AS qty_in,
    sil.quantity                  AS qty_out,
    sil.unit_price                AS rate,
    NULL::text                    AS notes
  FROM sales_invoice_items sil
  JOIN sales_invoices si ON si.id = sil.invoice_id
  WHERE si.status = 'POSTED'

  UNION ALL

  -- Credit Note Returns
  SELECT
    cn.organisation_id,
    cnl.product_id,
    cnl.batch_id,
    NULL::uuid                    AS location_id,
    cn.credit_note_date           AS txn_date,
    'CREDIT_NOTE'                 AS txn_type,
    cn.credit_note_no             AS txn_ref,
    cn.id                         AS txn_id,
    cnl.quantity                  AS qty_in,
    0::numeric                    AS qty_out,
    cnl.unit_price                AS rate,
    'Customer Return'::text        AS notes
  FROM credit_note_items cnl
  JOIN credit_notes cn ON cn.id = cnl.credit_note_id
  WHERE cn.status = 'POSTED'

  UNION ALL

  -- Stock Adjustments
  SELECT
    sa.organisation_id,
    sa.product_id,
    sa.batch_id,
    sa.location_id,
    sa.adjustment_date            AS txn_date,
    'ADJUSTMENT'                  AS txn_type,
    sa.adjustment_no              AS txn_ref,
    sa.id                         AS txn_id,
    GREATEST(sa.qty_adjustment, 0) AS qty_in,
    GREATEST(-sa.qty_adjustment, 0) AS qty_out,
    0::numeric                    AS rate,
    sa.notes
  FROM stock_adjustments sa

)
SELECT
  lr.*,
  p.product_name,
  p.product_code,
  p.hsn_sac_code,
  ib.batch_no,
  ib.expiry_date,
  loc.location_name,
  SUM(lr.qty_in - lr.qty_out) OVER (
    PARTITION BY lr.organisation_id, lr.product_id
    ORDER BY lr.txn_date, lr.txn_id
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  ) AS running_balance
FROM ledger_rows lr
LEFT JOIN products p   ON p.id = lr.product_id
LEFT JOIN inventory_batches ib ON ib.id = lr.batch_id
LEFT JOIN locations loc ON loc.id = lr.location_id;

-- ─── View: vw_stock_summary ──────────────────────────────────
-- Current stock on hand per product + location
CREATE OR REPLACE VIEW vw_stock_summary AS
SELECT
  organisation_id,
  product_id,
  product_name,
  product_code,
  hsn_sac_code,
  location_id,
  location_name,
  SUM(qty_in - qty_out) AS qty_on_hand
FROM vw_stock_ledger
GROUP BY
  organisation_id,
  product_id, product_name, product_code, hsn_sac_code,
  location_id, location_name;

-- ─── View: vw_batch_register ─────────────────────────────────
CREATE OR REPLACE VIEW vw_batch_register AS
SELECT
  ib.id              AS batch_id,
  ib.organisation_id,
  ib.product_id,
  p.product_name,
  p.product_code,
  ib.batch_no,
  ib.manufacture_date,
  ib.expiry_date,
  ib.purchase_rate,
  ib.mrp,
  CASE
    WHEN ib.expiry_date IS NULL        THEN 'NO_EXPIRY'
    WHEN ib.expiry_date < CURRENT_DATE THEN 'EXPIRED'
    WHEN ib.expiry_date < CURRENT_DATE + 90 THEN 'EXPIRING_SOON'
    ELSE 'VALID'
  END                AS expiry_status,
  COALESCE(SUM(gl.qty_in - gl.qty_out), 0) AS qty_on_hand
FROM inventory_batches ib
JOIN products p ON p.id = ib.product_id
LEFT JOIN vw_stock_ledger gl ON gl.batch_id = ib.id
GROUP BY
  ib.id, ib.organisation_id, ib.product_id,
  p.product_name, p.product_code,
  ib.batch_no, ib.manufacture_date, ib.expiry_date,
  ib.purchase_rate, ib.mrp;

-- Grant access to authenticated role
GRANT SELECT ON vw_stock_ledger    TO authenticated;
GRANT SELECT ON vw_stock_summary   TO authenticated;
GRANT SELECT ON vw_batch_register  TO authenticated;
GRANT SELECT, INSERT ON stock_adjustments TO authenticated;
