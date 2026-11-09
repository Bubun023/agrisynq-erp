-- 051: opening position for go-live, posted atomically.
--   * opening stock    -> new batch + stock_ledger OPENING movement at cost            (DR 1020 Stock in Hand)
--   * party balances   -> customers owe us (DR 1010) / we owe suppliers (CR 2001), carried on the party ledger
--   * other accounts   -> cash, bank, fixed assets, loans ... as debit/credit balances
--   * the difference is booked to 2100 Capital Account (opening balance equity) so the voucher always balances.
-- Controlled accounts (1010 Debtors, 2001 Creditors, 1020 Stock) can only be opened through parties / stock so
-- the sub-ledgers always tie to the books. Parties and accounts can be opened only once; stock can be added in
-- several runs (a batch number is unique per product).
CREATE OR REPLACE FUNCTION public.post_opening_balances(
  p_org uuid, p_branch uuid, p_as_of date, p_stock jsonb DEFAULT '[]', p_parties jsonb DEFAULT '[]', p_accounts jsonb DEFAULT '[]'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  v_tenant uuid := public.get_tenant_id();
  e        jsonb;
  v_n      int;
  v_batch  uuid;
  v_qty    numeric;
  v_rate   numeric;
  v_stock  numeric(18,2) := 0;
  v_lines  jsonb := '[]'::jsonb;
  v_dr     numeric(18,2) := 0;
  v_cr     numeric(18,2) := 0;
  v_amt    numeric(18,2);
  v_cramt  numeric(18,2);
  v_code   text;
  v_party  uuid;
  v_ptype  record;
  v_jv     uuid;
  v_stock_n int := 0; v_party_n int := 0; v_acct_n int := 0;
BEGIN
  IF v_tenant IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF NOT public.has_any_role(ARRAY['SUPER_ADMIN', 'BRANCH_ADMIN', 'ACCOUNTANT']) THEN
    RAISE EXCEPTION 'Only an admin or accountant can post opening balances' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM organisations WHERE id = p_org AND tenant_id = v_tenant) THEN RAISE EXCEPTION 'Organisation not found'; END IF;
  IF p_branch IS NOT NULL AND NOT EXISTS (SELECT 1 FROM branches WHERE id = p_branch AND tenant_id = v_tenant) THEN RAISE EXCEPTION 'Branch not found'; END IF;
  IF p_as_of IS NULL THEN RAISE EXCEPTION 'The opening date is required'; END IF;
  PERFORM public.assert_period_not_locked(v_tenant, p_org, p_as_of);

  -- stock
  v_n := 0;
  FOR e IN SELECT * FROM jsonb_array_elements(COALESCE(p_stock, '[]'::jsonb)) LOOP
    v_n := v_n + 1;
    v_qty := (e->>'qty')::numeric;  v_rate := COALESCE((e->>'rate')::numeric, 0);
    IF v_qty IS NULL OR v_qty <= 0 THEN RAISE EXCEPTION 'Stock row %: quantity must be greater than zero', v_n; END IF;
    IF v_rate < 0 THEN RAISE EXCEPTION 'Stock row %: cost cannot be negative', v_n; END IF;
    IF NOT EXISTS (SELECT 1 FROM products WHERE id = (e->>'product_id')::uuid AND tenant_id = v_tenant AND organisation_id = p_org) THEN
      RAISE EXCEPTION 'Stock row %: product not found', v_n; END IF;
    IF NOT EXISTS (SELECT 1 FROM locations WHERE id = (e->>'location_id')::uuid AND tenant_id = v_tenant AND organisation_id = p_org) THEN
      RAISE EXCEPTION 'Stock row %: location not found', v_n; END IF;
    IF btrim(COALESCE(e->>'batch_number', '')) = '' THEN RAISE EXCEPTION 'Stock row %: batch number is required', v_n; END IF;
    IF EXISTS (SELECT 1 FROM batch_register WHERE tenant_id = v_tenant AND organisation_id = p_org
                AND product_id = (e->>'product_id')::uuid AND batch_number = btrim(e->>'batch_number')) THEN
      RAISE EXCEPTION 'Stock row %: batch % already exists for this product', v_n, btrim(e->>'batch_number'); END IF;

    INSERT INTO batch_register (tenant_id, organisation_id, branch_id, batch_number, product_id, location_id, opening_qty, current_qty,
                                unit_of_measure, purchase_rate, purchase_rate_with_tax, landing_cost_per_unit, manufacture_date, expiry_date, status, created_by)
    SELECT v_tenant, p_org, p_branch, btrim(e->>'batch_number'), p.id, (e->>'location_id')::uuid, v_qty, 0,
           p.unit_of_measure, v_rate, v_rate, v_rate, NULLIF(e->>'manufacture_date','')::date, NULLIF(e->>'expiry_date','')::date, 'OPEN', auth.uid()
      FROM products p WHERE p.id = (e->>'product_id')::uuid
    RETURNING id INTO v_batch;

    INSERT INTO stock_ledger (tenant_id, organisation_id, branch_id, movement_type, movement_date, product_id, batch_id, to_location_id,
                              qty, unit_of_measure, rate_per_unit, source_document_type, source_document_no, narration, created_by)
    SELECT v_tenant, p_org, p_branch, 'OPENING', p_as_of, p.id, v_batch, (e->>'location_id')::uuid, v_qty, p.unit_of_measure, v_rate,
           'OPENING_BALANCE', 'OPENING-' || to_char(p_as_of, 'YYYYMMDD'), 'Opening stock', auth.uid()
      FROM products p WHERE p.id = (e->>'product_id')::uuid;
    v_stock := v_stock + round(v_qty * v_rate, 2);  v_stock_n := v_stock_n + 1;
  END LOOP;
  IF v_stock > 0 THEN
    v_lines := v_lines || jsonb_build_object('code', '1020', 'debit', v_stock);
    v_dr := v_dr + v_stock;
  END IF;

  -- party balances: a positive amount is the natural side (customer owes us / we owe the supplier), negative the opposite
  v_n := 0;
  FOR e IN SELECT * FROM jsonb_array_elements(COALESCE(p_parties, '[]'::jsonb)) LOOP
    v_n := v_n + 1;  v_party := (e->>'party_id')::uuid;  v_amt := round((e->>'amount')::numeric, 2);
    SELECT id, (COALESCE(is_customer, false) OR party_type IN ('CUSTOMER','BOTH')) AS cust,
              (COALESCE(is_supplier, false) OR party_type IN ('SUPPLIER','BOTH')) AS supp
      INTO v_ptype FROM parties WHERE id = v_party AND tenant_id = v_tenant AND organisation_id = p_org;
    IF NOT FOUND THEN RAISE EXCEPTION 'Party row %: party not found', v_n; END IF;
    IF v_amt IS NULL OR v_amt = 0 THEN RAISE EXCEPTION 'Party row %: amount must not be zero', v_n; END IF;
    IF NOT (v_ptype.cust OR v_ptype.supp) THEN RAISE EXCEPTION 'Party row %: only customers and suppliers can carry an opening balance', v_n; END IF;
    IF EXISTS (SELECT 1 FROM journal_voucher_lines l JOIN journal_vouchers j ON j.id = l.voucher_id
                WHERE j.tenant_id = v_tenant AND j.reference_type = 'OPENING_BALANCE' AND l.party_id = v_party) THEN
      RAISE EXCEPTION 'Party row %: this party already has an opening balance', v_n; END IF;
    IF e->>'side' = 'SUPPLIER' OR (e->>'side' IS NULL AND NOT v_ptype.cust) THEN
      IF v_amt > 0 THEN
        v_lines := v_lines || jsonb_build_object('code', '2001', 'credit', v_amt, 'party', v_party);  v_cr := v_cr + v_amt;
      ELSE
        v_lines := v_lines || jsonb_build_object('code', '2001', 'debit', -v_amt, 'party', v_party);  v_dr := v_dr - v_amt;
      END IF;
    ELSE
      IF v_amt > 0 THEN
        v_lines := v_lines || jsonb_build_object('code', '1010', 'debit', v_amt, 'party', v_party);  v_dr := v_dr + v_amt;
      ELSE
        v_lines := v_lines || jsonb_build_object('code', '1010', 'credit', -v_amt, 'party', v_party);  v_cr := v_cr - v_amt;
      END IF;
    END IF;
    v_party_n := v_party_n + 1;
  END LOOP;

  -- other ledger accounts
  v_n := 0;
  FOR e IN SELECT * FROM jsonb_array_elements(COALESCE(p_accounts, '[]'::jsonb)) LOOP
    v_n := v_n + 1;  v_code := btrim(e->>'account_code');
    IF v_code IN ('1010', '2001', '1020', '2100') THEN
      RAISE EXCEPTION 'Account row %: % is controlled (open it through parties / stock; capital is calculated)', v_n, v_code; END IF;
    IF NOT EXISTS (SELECT 1 FROM chart_of_accounts WHERE tenant_id = v_tenant AND account_code = v_code AND is_active) THEN
      RAISE EXCEPTION 'Account row %: account % not found', v_n, v_code; END IF;
    IF EXISTS (SELECT 1 FROM journal_voucher_lines l JOIN journal_vouchers j ON j.id = l.voucher_id
                JOIN chart_of_accounts a ON a.id = l.account_id
                WHERE j.tenant_id = v_tenant AND j.reference_type = 'OPENING_BALANCE' AND a.account_code = v_code) THEN
      RAISE EXCEPTION 'Account row %: account % already has an opening balance', v_n, v_code; END IF;
    v_amt := round(COALESCE((e->>'debit')::numeric, 0), 2);
    v_cramt := round(COALESCE((e->>'credit')::numeric, 0), 2);
    IF v_amt < 0 OR v_cramt < 0 THEN RAISE EXCEPTION 'Account row %: amounts cannot be negative', v_n; END IF;
    IF (v_amt > 0) = (v_cramt > 0) THEN RAISE EXCEPTION 'Account row %: give either a debit or a credit amount', v_n; END IF;
    v_lines := v_lines || jsonb_build_object('code', v_code, 'debit', v_amt, 'credit', v_cramt);
    v_dr := v_dr + v_amt;  v_cr := v_cr + v_cramt;  v_acct_n := v_acct_n + 1;
  END LOOP;

  IF v_stock_n + v_party_n + v_acct_n = 0 THEN RAISE EXCEPTION 'Nothing to import'; END IF;

  -- balance with opening-balance equity (2100)
  IF v_dr > v_cr THEN
    v_lines := v_lines || jsonb_build_object('code', '2100', 'credit', v_dr - v_cr);
  ELSIF v_cr > v_dr THEN
    v_lines := v_lines || jsonb_build_object('code', '2100', 'debit', v_cr - v_dr);
  END IF;

  v_jv := public._create_posted_jv(v_tenant, p_org, p_branch, p_as_of, 'JOURNAL', 'OPENING_BALANCE', NULL,
            'Opening balances as on ' || to_char(p_as_of, 'DD-Mon-YYYY'), v_lines);
  RETURN jsonb_build_object('voucher_id', v_jv, 'stock_rows', v_stock_n, 'party_rows', v_party_n, 'account_rows', v_acct_n,
                            'stock_value', v_stock, 'capital_balancing', v_dr - v_cr);
END $$;

REVOKE ALL ON FUNCTION public.post_opening_balances(uuid, uuid, date, jsonb, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.post_opening_balances(uuid, uuid, date, jsonb, jsonb, jsonb) TO authenticated;
