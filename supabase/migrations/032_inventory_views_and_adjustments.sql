-- ============================================================
-- Migration 032: Inventory Views & Stock Adjustments
-- Phase 9 - FertiLedger ERP
-- ============================================================
-- Built on the real inventory model from 019/020:
--   stock_ledger   - insert-only movement log (single source of truth)
--   stock_balance  - view of on-hand per (product, batch, location)
--   batch_register - batch master
-- Adjustments are a document (stock_adjustments) that ALWAYS produces a
-- stock_ledger row, atomically, via post_stock_adjustment().

-- ─── Reasons ──────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE stock_adjustment_reason AS ENUM (
    'DAMAGE', 'EXPIRY', 'THEFT', 'RECOUNT', 'SAMPLE', 'OTHER'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── Stock Adjustments (document header) ──────────────────────
CREATE TABLE IF NOT EXISTS stock_adjustments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id),
  organisation_id  uuid NOT NULL REFERENCES organisations(id),
  branch_id        uuid REFERENCES branches(id),
  adjustment_no    text NOT NULL,
  adjustment_date  date NOT NULL DEFAULT CURRENT_DATE,
  product_id       uuid NOT NULL REFERENCES products(id),
  batch_id         uuid REFERENCES batch_register(id),
  location_id      uuid NOT NULL REFERENCES locations(id),
  reason           stock_adjustment_reason NOT NULL DEFAULT 'RECOUNT',
  qty_before       numeric(15,3) NOT NULL DEFAULT 0,
  qty_adjustment   numeric(15,3) NOT NULL CHECK (qty_adjustment <> 0),  -- + increase / - decrease
  qty_after        numeric(15,3) NOT NULL CHECK (qty_after >= 0),
  unit_of_measure  text NOT NULL,
  ledger_entry_id  uuid REFERENCES stock_ledger(id),
  notes            text,
  created_by       uuid REFERENCES auth.users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organisation_id, adjustment_no)
);

ALTER TABLE stock_adjustments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "stock_adj_tenant_select" ON stock_adjustments
  FOR SELECT USING (tenant_id = public.get_tenant_id());
CREATE POLICY "stock_adj_tenant_insert" ON stock_adjustments
  FOR INSERT WITH CHECK (tenant_id = public.get_tenant_id());
-- Adjustments are never edited or deleted: correct with a new opposite adjustment.

CREATE INDEX IF NOT EXISTS idx_stock_adj_org     ON stock_adjustments(organisation_id, adjustment_date DESC);
CREATE INDEX IF NOT EXISTS idx_stock_adj_product ON stock_adjustments(product_id);
CREATE INDEX IF NOT EXISTS idx_stock_adj_batch   ON stock_adjustments(batch_id);

-- ─── Atomic posting function ──────────────────────────────────
-- SECURITY INVOKER (default): runs as the caller, so RLS and the period-lock
-- trigger on stock_ledger apply. Serialised per organisation by an advisory
-- lock so numbering and the balance check cannot race.
CREATE OR REPLACE FUNCTION public.post_stock_adjustment(
  p_organisation_id uuid,
  p_branch_id       uuid,
  p_date            date,
  p_product_id      uuid,
  p_batch_id        uuid,
  p_location_id     uuid,
  p_reason          stock_adjustment_reason,
  p_qty_adjustment  numeric,
  p_notes           text DEFAULT NULL
)
RETURNS stock_adjustments
LANGUAGE plpgsql
AS $$
DECLARE
  v_tenant   uuid := public.get_tenant_id();
  v_uom      text;
  v_before   numeric(15,3);
  v_after    numeric(15,3);
  v_seq      int;
  v_type     stock_movement_type;
  v_ledger   uuid;
  v_row      stock_adjustments;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_qty_adjustment IS NULL OR p_qty_adjustment = 0 THEN
    RAISE EXCEPTION 'Adjustment quantity must be non-zero';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('stock_adj:' || p_organisation_id::text, 0));

  SELECT unit_of_measure INTO v_uom
    FROM products WHERE id = p_product_id AND tenant_id = v_tenant AND organisation_id = p_organisation_id;
  IF v_uom IS NULL THEN RAISE EXCEPTION 'Product not found'; END IF;

  PERFORM 1 FROM locations WHERE id = p_location_id AND tenant_id = v_tenant AND organisation_id = p_organisation_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Location not found'; END IF;

  IF p_batch_id IS NOT NULL THEN
    PERFORM 1 FROM batch_register
      WHERE id = p_batch_id AND tenant_id = v_tenant AND product_id = p_product_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Batch does not belong to this product'; END IF;
  END IF;

  -- Current balance for exactly this (product, batch, location)
  SELECT COALESCE(SUM(balance_qty), 0) INTO v_before
    FROM stock_balance
   WHERE tenant_id = v_tenant AND organisation_id = p_organisation_id
     AND product_id = p_product_id
     AND location_id = p_location_id
     AND batch_id IS NOT DISTINCT FROM p_batch_id;

  v_after := v_before + p_qty_adjustment;
  IF v_after < 0 THEN
    RAISE EXCEPTION 'Adjustment would make stock negative (%). Current stock: %', v_after, v_before;
  END IF;

  v_type := CASE
    WHEN p_qty_adjustment > 0 THEN 'ADJ_INCREASE'
    WHEN p_reason = 'EXPIRY'  THEN 'EXPIRY_WRITE_OFF'
    WHEN p_reason = 'DAMAGE'  THEN 'DAMAGE_WRITE_OFF'
    ELSE 'ADJ_DECREASE'
  END;

  SELECT COALESCE(MAX(NULLIF(regexp_replace(adjustment_no, '\D', '', 'g'), '')::int), 0) + 1
    INTO v_seq FROM stock_adjustments WHERE organisation_id = p_organisation_id;

  INSERT INTO stock_ledger (
    tenant_id, organisation_id, branch_id, movement_type, movement_date,
    product_id, batch_id, from_location_id, to_location_id,
    qty, unit_of_measure, source_document_type, source_document_no, narration, created_by
  ) VALUES (
    v_tenant, p_organisation_id, p_branch_id, v_type, p_date,
    p_product_id, p_batch_id,
    CASE WHEN p_qty_adjustment < 0 THEN p_location_id END,
    CASE WHEN p_qty_adjustment > 0 THEN p_location_id END,
    abs(p_qty_adjustment), v_uom, 'STOCK_ADJUSTMENT',
    'ADJ-' || lpad(v_seq::text, 5, '0'),
    COALESCE(p_notes, p_reason::text), auth.uid()
  ) RETURNING id INTO v_ledger;

  INSERT INTO stock_adjustments (
    tenant_id, organisation_id, branch_id, adjustment_no, adjustment_date,
    product_id, batch_id, location_id, reason,
    qty_before, qty_adjustment, qty_after, unit_of_measure, ledger_entry_id, notes, created_by
  ) VALUES (
    v_tenant, p_organisation_id, p_branch_id, 'ADJ-' || lpad(v_seq::text, 5, '0'), p_date,
    p_product_id, p_batch_id, p_location_id, p_reason,
    v_before, p_qty_adjustment, v_after, v_uom, v_ledger, p_notes, auth.uid()
  ) RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION public.post_stock_adjustment(uuid,uuid,date,uuid,uuid,uuid,stock_adjustment_reason,numeric,text) TO authenticated;

-- stock_balance (020) was created without security_invoker, so it ran as the view
-- owner and bypassed stock_ledger RLS. Make it honour the caller's tenant policy.
ALTER VIEW stock_balance SET (security_invoker = true);

-- ─── View: vw_stock_ledger ────────────────────────────────────
-- One row per stock_ledger movement, signed in/out, with running balance
-- per (product, location). Mirrors the in/out classification of stock_balance.
CREATE OR REPLACE VIEW vw_stock_ledger WITH (security_invoker = true) AS
WITH m AS (
  SELECT
    sl.id, sl.tenant_id, sl.organisation_id, sl.product_id, sl.batch_id,
    CASE WHEN sl.movement_type IN ('SALE','RETURN_TO_SUPPLIER','TRANSFER_OUT','QUARANTINE_HOLD','ADJ_DECREASE','EXPIRY_WRITE_OFF','DAMAGE_WRITE_OFF','FMS_SUBSIDY_OUT')
         THEN COALESCE(sl.from_location_id, sl.to_location_id)
         ELSE COALESCE(sl.to_location_id, sl.from_location_id) END AS location_id,
    sl.movement_date, sl.movement_ts, sl.movement_type::text AS txn_type,
    sl.source_document_no, sl.rate_per_unit, sl.narration,
    CASE WHEN sl.movement_type IN ('GRN','OPENING','RETURN_FROM_SALE','TRANSFER_IN','QUARANTINE_RELEASE','ADJ_INCREASE','FMS_RETURN')
         THEN sl.qty ELSE 0 END AS qty_in,
    CASE WHEN sl.movement_type IN ('SALE','RETURN_TO_SUPPLIER','TRANSFER_OUT','QUARANTINE_HOLD','ADJ_DECREASE','EXPIRY_WRITE_OFF','DAMAGE_WRITE_OFF','FMS_SUBSIDY_OUT')
         THEN sl.qty ELSE 0 END AS qty_out
  FROM stock_ledger sl
  WHERE sl.is_reversal = FALSE
)
SELECT
  m.tenant_id,
  m.organisation_id,
  m.movement_date                        AS txn_date,
  m.txn_type,
  COALESCE(m.source_document_no, '')     AS txn_ref,
  m.id                                   AS txn_id,
  m.product_id,
  p.name                                 AS product_name,
  p.product_code,
  p.hsn_code                             AS hsn_sac_code,
  m.batch_id,
  b.batch_number                         AS batch_no,
  b.expiry_date,
  m.location_id,
  l.name                                 AS location_name,
  m.qty_in,
  m.qty_out,
  m.rate_per_unit                        AS rate,
  SUM(m.qty_in - m.qty_out) OVER (
    PARTITION BY m.organisation_id, m.product_id, m.location_id
    ORDER BY m.movement_ts, m.id
    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
  )                                      AS running_balance,
  m.narration                            AS notes
FROM m
JOIN products p            ON p.id = m.product_id
LEFT JOIN batch_register b ON b.id = m.batch_id
LEFT JOIN locations l      ON l.id = m.location_id;

-- ─── View: vw_stock_summary ──────────────────────────────────
-- On-hand per product + location (batches rolled up).
CREATE OR REPLACE VIEW vw_stock_summary WITH (security_invoker = true) AS
SELECT
  sb.tenant_id,
  sb.organisation_id,
  sb.product_id,
  p.name            AS product_name,
  p.product_code,
  p.hsn_code        AS hsn_sac_code,
  sb.location_id,
  l.name            AS location_name,
  SUM(sb.balance_qty) AS qty_on_hand
FROM stock_balance sb
JOIN products p       ON p.id = sb.product_id
LEFT JOIN locations l ON l.id = sb.location_id
GROUP BY sb.tenant_id, sb.organisation_id, sb.product_id, p.name, p.product_code,
         p.hsn_code, sb.location_id, l.name;

-- ─── View: vw_batch_register ─────────────────────────────────
CREATE OR REPLACE VIEW vw_batch_register WITH (security_invoker = true) AS
SELECT
  b.id               AS batch_id,
  b.tenant_id,
  b.organisation_id,
  b.product_id,
  p.name             AS product_name,
  p.product_code,
  b.batch_number     AS batch_no,
  b.manufacture_date,
  b.expiry_date,
  b.purchase_rate,
  p.mrp,
  b.status::text     AS batch_status,
  CASE
    WHEN b.expiry_date IS NULL              THEN 'NO_EXPIRY'
    WHEN b.expiry_date < CURRENT_DATE       THEN 'EXPIRED'
    WHEN b.expiry_date < CURRENT_DATE + 90  THEN 'EXPIRING_SOON'
    ELSE 'VALID'
  END                AS expiry_status,
  COALESCE((SELECT SUM(sb.balance_qty) FROM stock_balance sb WHERE sb.batch_id = b.id), 0) AS qty_on_hand
FROM batch_register b
JOIN products p ON p.id = b.product_id;

GRANT SELECT ON vw_stock_ledger, vw_stock_summary, vw_batch_register TO authenticated;
GRANT SELECT, INSERT ON stock_adjustments TO authenticated;
