-- ============================================================
-- Migration 043: Subsidy claims (claim -> receive -> clear the receivable)
-- FertiLedger ERP
-- ============================================================
-- Posted subsidised farmer sales book DR Subsidy Receivable (1040) (migration 040).
-- Lifecycle of a claim:
--   create_subsidy_claim   gathers unclaimed POSTED sales of a period/subsidy type   (DRAFT)
--   submit_subsidy_claim   marks it filed; its sales become SUBSIDY_CLAIMED          (SUBMITTED)
--   record_subsidy_receipt money arrives (partial or full): DR Bank, CR 1040;
--                          when fully received the sales become SUBSIDY_RECEIVED     (PARTIALLY/FULLY_RECEIVED)
--   reject_subsidy_claim   government rejects a claim with nothing received: sales go
--                          back to POSTED and can be claimed again                    (REJECTED)
--   cancel_subsidy_claim   discards a DRAFT                                           (CANCELLED)
-- All writes go through these SECURITY DEFINER functions; users have read-only access,
-- so a claim's totals can never drift from the ledger.

ALTER TABLE subsidy_claims ADD COLUMN IF NOT EXISTS rejection_reason text;
ALTER TABLE subsidy_claims ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE farmer_sales   ADD COLUMN IF NOT EXISTS subsidy_claim_id uuid REFERENCES subsidy_claims(id);
CREATE INDEX IF NOT EXISTS idx_fs_claim ON farmer_sales(subsidy_claim_id) WHERE subsidy_claim_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS subsidy_receipts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  organisation_id     uuid NOT NULL REFERENCES organisations(id),
  claim_id            uuid NOT NULL REFERENCES subsidy_claims(id),
  receipt_date        date NOT NULL,
  amount              numeric(15,2) NOT NULL CHECK (amount > 0),
  reference_no        text,
  bank_account_id     uuid NOT NULL REFERENCES chart_of_accounts(id),
  journal_voucher_id  uuid REFERENCES journal_vouchers(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid REFERENCES auth.users(id)
);
CREATE INDEX IF NOT EXISTS idx_subsidy_receipts_claim ON subsidy_receipts(claim_id);

ALTER TABLE subsidy_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY sr_select ON subsidy_receipts FOR SELECT USING (tenant_id = public.get_tenant_id());

-- Read-only for users (replaces 026's open insert/update policies)
DROP POLICY IF EXISTS sc_tenant_insert ON subsidy_claims;
DROP POLICY IF EXISTS sc_tenant_update ON subsidy_claims;
REVOKE ALL ON subsidy_claims, subsidy_receipts FROM anon, authenticated;
GRANT SELECT ON subsidy_claims, subsidy_receipts TO authenticated;

-- ─── Period lock: claiming/receiving is not an accounting change to the sale ──
-- The generic trigger (036/040) blocked ANY status change in a locked month. Moving a posted
-- sale between POSTED / SUBSIDY_CLAIMED / SUBSIDY_RECEIVED does not change the sale's books
-- (the receipt posts its own journal, dated by the receipt), and claims are normally filed
-- after the period is closed. Cancellation and edits to the date stay locked.
CREATE OR REPLACE FUNCTION public.trg_enforce_period_lock_fs()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_post_states text[] := ARRAY['POSTED', 'SUBSIDY_CLAIMED', 'SUBSIDY_RECEIVED'];
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.sale_date IS NOT DISTINCT FROM OLD.sale_date
       AND (NEW.status = OLD.status
            OR (OLD.status::text = ANY (v_post_states) AND NEW.status::text = ANY (v_post_states))) THEN
      RETURN NEW;
    END IF;
    PERFORM public.assert_period_not_locked(OLD.tenant_id, OLD.organisation_id, OLD.sale_date);
  END IF;
  PERFORM public.assert_period_not_locked(NEW.tenant_id, NEW.organisation_id, NEW.sale_date);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS enforce_period_lock ON farmer_sales;
CREATE TRIGGER enforce_period_lock BEFORE INSERT OR UPDATE ON farmer_sales
  FOR EACH ROW EXECUTE FUNCTION public.trg_enforce_period_lock_fs();

-- A sale that belongs to a claim cannot be cancelled until it is taken out of the claim
CREATE OR REPLACE FUNCTION public.trg_fs_claim_guard()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'CANCELLED' AND OLD.status <> 'CANCELLED' AND OLD.subsidy_claim_id IS NOT NULL THEN
    RAISE EXCEPTION 'Sale % is part of a subsidy claim and cannot be cancelled until it is removed from the claim', OLD.sale_number;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS fs_claim_guard ON farmer_sales;
CREATE TRIGGER fs_claim_guard BEFORE UPDATE ON farmer_sales
  FOR EACH ROW EXECUTE FUNCTION public.trg_fs_claim_guard();

-- ─── create_subsidy_claim ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_subsidy_claim(
  p_organisation_id uuid,
  p_period_from     date,
  p_period_to       date,
  p_subsidy_type    text,
  p_scheme_name     text DEFAULT NULL
) RETURNS subsidy_claims
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_tenant uuid := public.get_tenant_id();
  v_ids    uuid[];
  v_qty    numeric;
  v_sub    numeric;
  v_n      int;
  v_no     text;
  c        subsidy_claims%ROWTYPE;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT EXISTS (SELECT 1 FROM organisations WHERE id = p_organisation_id AND tenant_id = v_tenant) THEN
    RAISE EXCEPTION 'Organisation not found';
  END IF;
  IF p_period_to < p_period_from THEN RAISE EXCEPTION 'Period end is before period start'; END IF;
  IF p_subsidy_type NOT IN ('NEEM_COATED_UREA', 'NBS_FERTILIZER', 'STATE_SUBSIDY') THEN
    RAISE EXCEPTION 'Choose a subsidy type to claim';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('subsidy_claim:' || p_organisation_id::text, 0));

  v_ids := ARRAY(
    SELECT id FROM farmer_sales
     WHERE tenant_id = v_tenant AND organisation_id = p_organisation_id
       AND status = 'POSTED' AND subsidy_claim_id IS NULL
       AND subsidy_type::text = p_subsidy_type AND total_subsidy_amount > 0
       AND sale_date BETWEEN p_period_from AND p_period_to
     FOR UPDATE);
  IF COALESCE(array_length(v_ids, 1), 0) = 0 THEN
    RAISE EXCEPTION 'No unclaimed posted sales with this subsidy type in the period';
  END IF;

  SELECT SUM(qty_sold), SUM(total_subsidy_amount) INTO v_qty, v_sub FROM farmer_sales WHERE id = ANY (v_ids);

  SELECT COALESCE(MAX(NULLIF(regexp_replace(claim_number, '^SC-\d{4}-', ''), '')::int), 0) + 1 INTO v_n
    FROM subsidy_claims
   WHERE tenant_id = v_tenant AND organisation_id = p_organisation_id
     AND claim_number LIKE 'SC-' || to_char(CURRENT_DATE, 'YYYY') || '-%';
  v_no := 'SC-' || to_char(CURRENT_DATE, 'YYYY') || '-' || lpad(v_n::text, 5, '0');

  INSERT INTO subsidy_claims (tenant_id, organisation_id, claim_number, claim_date, period_from, period_to,
                              subsidy_type, scheme_name, total_qty_claimed, total_subsidy_claimed, claim_status, created_by)
  VALUES (v_tenant, p_organisation_id, v_no, CURRENT_DATE, p_period_from, p_period_to,
          p_subsidy_type::subsidy_type_enum, NULLIF(btrim(p_scheme_name), ''), v_qty, v_sub, 'DRAFT', auth.uid())
  RETURNING * INTO c;

  UPDATE farmer_sales SET subsidy_claim_id = c.id WHERE id = ANY (v_ids);
  RETURN c;
END $$;

-- ─── submit_subsidy_claim ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.submit_subsidy_claim(p_claim_id uuid, p_submitted_on date, p_government_ref text DEFAULT NULL)
RETURNS subsidy_claims
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_tenant uuid := public.get_tenant_id();
  c        subsidy_claims%ROWTYPE;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO c FROM subsidy_claims WHERE id = p_claim_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Subsidy claim not found'; END IF;
  IF c.claim_status <> 'DRAFT' THEN RAISE EXCEPTION 'Only DRAFT claims can be submitted (status: %)', c.claim_status; END IF;
  IF p_submitted_on IS NULL OR p_submitted_on > CURRENT_DATE THEN RAISE EXCEPTION 'Submission date cannot be in the future'; END IF;

  UPDATE farmer_sales SET status = 'SUBSIDY_CLAIMED', updated_by = auth.uid()
   WHERE subsidy_claim_id = p_claim_id AND tenant_id = v_tenant AND status = 'POSTED';
  UPDATE subsidy_claims SET claim_status = 'SUBMITTED', submitted_on = p_submitted_on,
         government_ref_no = NULLIF(btrim(p_government_ref), ''), updated_at = now()
   WHERE id = p_claim_id RETURNING * INTO c;
  RETURN c;
END $$;

-- ─── record_subsidy_receipt ───────────────────────────────────
CREATE OR REPLACE FUNCTION public.record_subsidy_receipt(
  p_claim_id   uuid,
  p_amount     numeric,
  p_date       date,
  p_account_id uuid DEFAULT NULL,        -- bank/cash ledger account; default Bank (1002)
  p_reference  text DEFAULT NULL
) RETURNS subsidy_claims
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_tenant uuid := public.get_tenant_id();
  c        subsidy_claims%ROWTYPE;
  v_acct   uuid;
  v_recv   uuid := NULL;
  v_jv     uuid;
  v_no     text;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO c FROM subsidy_claims WHERE id = p_claim_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Subsidy claim not found'; END IF;
  IF c.claim_status NOT IN ('SUBMITTED', 'PARTIALLY_RECEIVED') THEN
    RAISE EXCEPTION 'Receipts can only be recorded against a submitted claim (status: %)', c.claim_status;
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'Amount must be positive'; END IF;
  IF round(p_amount, 2) <> p_amount THEN RAISE EXCEPTION 'Amount cannot have more than 2 decimals'; END IF;
  IF p_amount > c.subsidy_pending THEN
    RAISE EXCEPTION 'Receipt (%) exceeds the amount still pending on this claim (%)', p_amount, c.subsidy_pending;
  END IF;
  IF p_date IS NULL OR p_date > CURRENT_DATE THEN RAISE EXCEPTION 'Receipt date cannot be in the future'; END IF;

  v_acct := COALESCE(p_account_id, public._sys_account(v_tenant, '1002'));
  IF NOT EXISTS (SELECT 1 FROM chart_of_accounts WHERE id = v_acct AND tenant_id = v_tenant
                  AND organisation_id = c.organisation_id AND account_type = 'ASSET' AND is_active) THEN
    RAISE EXCEPTION 'Choose an active bank or cash account';
  END IF;
  v_recv := public._sys_account(v_tenant, '1040');

  v_no := 'SR-' || to_char(p_date, 'YYYY') || '-' || lpad(nextval('auto_jv_seq')::text, 6, '0');
  INSERT INTO journal_vouchers (tenant_id, organisation_id, voucher_no, voucher_date, voucher_type, reference_type, reference_id,
                                narration, status, total_debit, total_credit, posted_at, posted_by, created_by, updated_by)
  VALUES (v_tenant, c.organisation_id, v_no, p_date, 'RECEIPT', 'SUBSIDY_CLAIM', p_claim_id,
          'Subsidy received - claim ' || c.claim_number || COALESCE(' (' || NULLIF(btrim(p_reference), '') || ')', ''),
          'POSTED', p_amount, p_amount, now(), auth.uid(), auth.uid(), auth.uid())
  RETURNING id INTO v_jv;
  INSERT INTO journal_voucher_lines (tenant_id, voucher_id, line_no, account_id, debit_amount, credit_amount, narration)
  VALUES (v_tenant, v_jv, 1, v_acct, p_amount, 0, 'Subsidy received ' || c.claim_number),
         (v_tenant, v_jv, 2, v_recv, 0, p_amount, 'Subsidy received ' || c.claim_number);

  INSERT INTO subsidy_receipts (tenant_id, organisation_id, claim_id, receipt_date, amount, reference_no, bank_account_id,
                                journal_voucher_id, created_by)
  VALUES (v_tenant, c.organisation_id, p_claim_id, p_date, p_amount, NULLIF(btrim(p_reference), ''), v_acct, v_jv, auth.uid());

  UPDATE subsidy_claims SET subsidy_received = subsidy_received + p_amount, updated_at = now(),
         claim_status = CASE WHEN subsidy_received + p_amount >= total_subsidy_claimed THEN 'FULLY_RECEIVED' ELSE 'PARTIALLY_RECEIVED' END
   WHERE id = p_claim_id RETURNING * INTO c;

  IF c.claim_status = 'FULLY_RECEIVED' THEN
    UPDATE farmer_sales SET status = 'SUBSIDY_RECEIVED', updated_by = auth.uid()
     WHERE subsidy_claim_id = p_claim_id AND tenant_id = v_tenant AND status = 'SUBSIDY_CLAIMED';
  END IF;
  RETURN c;
END $$;

-- ─── reject_subsidy_claim ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reject_subsidy_claim(p_claim_id uuid, p_reason text)
RETURNS subsidy_claims
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_tenant uuid := public.get_tenant_id();
  c        subsidy_claims%ROWTYPE;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF COALESCE(btrim(p_reason), '') = '' THEN RAISE EXCEPTION 'A rejection reason is required'; END IF;
  SELECT * INTO c FROM subsidy_claims WHERE id = p_claim_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Subsidy claim not found'; END IF;
  IF c.claim_status <> 'SUBMITTED' THEN
    RAISE EXCEPTION 'Only a submitted claim can be rejected (status: %)', c.claim_status;
  END IF;
  IF c.subsidy_received > 0 THEN RAISE EXCEPTION 'Money has already been received against this claim'; END IF;

  UPDATE farmer_sales SET status = 'POSTED', subsidy_claim_id = NULL, updated_by = auth.uid()
   WHERE subsidy_claim_id = p_claim_id AND tenant_id = v_tenant;
  UPDATE subsidy_claims SET claim_status = 'REJECTED', rejection_reason = p_reason, updated_at = now()
   WHERE id = p_claim_id RETURNING * INTO c;
  RETURN c;
END $$;

-- ─── cancel_subsidy_claim (drafts only) ───────────────────────
CREATE OR REPLACE FUNCTION public.cancel_subsidy_claim(p_claim_id uuid)
RETURNS subsidy_claims
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_tenant uuid := public.get_tenant_id();
  c        subsidy_claims%ROWTYPE;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  SELECT * INTO c FROM subsidy_claims WHERE id = p_claim_id AND tenant_id = v_tenant FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Subsidy claim not found'; END IF;
  IF c.claim_status <> 'DRAFT' THEN RAISE EXCEPTION 'Only DRAFT claims can be cancelled (status: %)', c.claim_status; END IF;

  UPDATE farmer_sales SET subsidy_claim_id = NULL WHERE subsidy_claim_id = p_claim_id AND tenant_id = v_tenant;
  UPDATE subsidy_claims SET claim_status = 'CANCELLED', updated_at = now() WHERE id = p_claim_id RETURNING * INTO c;
  RETURN c;
END $$;

REVOKE ALL ON FUNCTION public.create_subsidy_claim(uuid,date,date,text,text), public.submit_subsidy_claim(uuid,date,text),
  public.record_subsidy_receipt(uuid,numeric,date,uuid,text), public.reject_subsidy_claim(uuid,text),
  public.cancel_subsidy_claim(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_subsidy_claim(uuid,date,date,text,text), public.submit_subsidy_claim(uuid,date,text),
  public.record_subsidy_receipt(uuid,numeric,date,uuid,text), public.reject_subsidy_claim(uuid,text),
  public.cancel_subsidy_claim(uuid) TO authenticated;

-- ─── View: claims with sale counts ────────────────────────────
CREATE OR REPLACE VIEW vw_subsidy_claims WITH (security_invoker = true) AS
SELECT c.*,
       (SELECT COUNT(*) FROM farmer_sales s WHERE s.subsidy_claim_id = c.id)  AS sale_count,
       (SELECT COUNT(*) FROM subsidy_receipts r WHERE r.claim_id = c.id)      AS receipt_count
  FROM subsidy_claims c;
GRANT SELECT ON vw_subsidy_claims TO authenticated;
