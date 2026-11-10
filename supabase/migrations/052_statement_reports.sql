-- 052: report functions - balance sheet source, account ledger, party statement, stock valuation and ageing.
-- All are SECURITY INVOKER (the default): they see only what the signed-in user's RLS allows, and also filter on the
-- session tenant explicitly. Only POSTED vouchers count. Sign convention: debit positive, credit negative.

-- balance of every account as on a date (account-level opening balance + posted lines up to and including the date)
CREATE OR REPLACE FUNCTION public.rpt_account_balances(p_as_of date)
RETURNS TABLE (account_id uuid, account_code text, account_name text, account_type text, account_group text, balance numeric)
LANGUAGE sql STABLE AS $$
  SELECT a.id, a.account_code, a.account_name, a.account_type::text, a.account_group,
         round(CASE WHEN a.opening_balance_type = 'CR' THEN -COALESCE(a.opening_balance, 0) ELSE COALESCE(a.opening_balance, 0) END
               + COALESCE(SUM(l.debit_amount - l.credit_amount), 0), 2)
    FROM chart_of_accounts a
    LEFT JOIN journal_vouchers v ON v.tenant_id = a.tenant_id AND v.status = 'POSTED' AND v.voucher_date <= p_as_of
    LEFT JOIN journal_voucher_lines l ON l.voucher_id = v.id AND l.account_id = a.id
   WHERE a.tenant_id = public.get_tenant_id() AND a.is_active
   GROUP BY a.id, a.account_code, a.account_name, a.account_type, a.account_group, a.opening_balance, a.opening_balance_type
   ORDER BY a.account_code
$$;

-- ledger of one account for a period with a running balance; the first row is the brought-forward balance
CREATE OR REPLACE FUNCTION public.rpt_account_ledger(p_account uuid, p_from date, p_to date)
RETURNS TABLE (seq bigint, txn_date date, voucher_no text, voucher_type text, particulars text, party_name text,
               debit numeric, credit numeric, running_balance numeric)
LANGUAGE sql STABLE AS $$
  WITH acct AS (
    SELECT a.id, round(CASE WHEN a.opening_balance_type = 'CR' THEN -COALESCE(a.opening_balance, 0) ELSE COALESCE(a.opening_balance, 0) END, 2) AS ob
      FROM chart_of_accounts a WHERE a.id = p_account AND a.tenant_id = public.get_tenant_id()
  ), lines AS (
    SELECT v.voucher_date, v.voucher_no, v.voucher_type::text AS vtype, COALESCE(NULLIF(l.narration, ''), v.narration) AS narr,
           p.name AS party, l.debit_amount, l.credit_amount, v.created_at, l.line_no
      FROM acct JOIN journal_voucher_lines l ON l.account_id = acct.id
      JOIN journal_vouchers v ON v.id = l.voucher_id AND v.status = 'POSTED' AND v.tenant_id = public.get_tenant_id()
      LEFT JOIN parties p ON p.id = l.party_id
  ), brought AS (
    SELECT (SELECT ob FROM acct) + COALESCE(SUM(debit_amount - credit_amount), 0) AS bf FROM lines WHERE voucher_date < p_from
  ), body AS (
    SELECT voucher_date, voucher_no, vtype, narr, party, debit_amount, credit_amount,
           row_number() OVER (ORDER BY voucher_date, created_at, voucher_no, line_no) AS rn
      FROM lines WHERE voucher_date BETWEEN p_from AND p_to
  ), allrows AS (
    SELECT 0::bigint AS rn, p_from AS d, NULL::text AS vno, NULL::text AS vt, 'Brought forward'::text AS narr, NULL::text AS party,
           GREATEST((SELECT bf FROM brought), 0) AS dr, GREATEST(-(SELECT bf FROM brought), 0) AS cr
     WHERE EXISTS (SELECT 1 FROM acct)
    UNION ALL
    SELECT rn, voucher_date, voucher_no, vtype, narr, party, debit_amount, credit_amount FROM body
  )
  SELECT rn, d, vno, vt, narr, party, dr, cr,
         round(SUM(dr - cr) OVER (ORDER BY rn ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW), 2)
    FROM allrows ORDER BY rn
$$;

-- customer / supplier statement: movements on the receivable and payable control accounts for one party.
-- Positive balance = the party owes us; negative = we owe the party.
CREATE OR REPLACE FUNCTION public.rpt_party_statement(p_party uuid, p_from date, p_to date)
RETURNS TABLE (seq bigint, txn_date date, voucher_no text, voucher_type text, particulars text, account_code text,
               debit numeric, credit numeric, running_balance numeric)
LANGUAGE sql STABLE AS $$
  WITH lines AS (
    SELECT v.voucher_date, v.voucher_no, v.voucher_type::text AS vtype, COALESCE(NULLIF(l.narration, ''), v.narration) AS narr,
           a.account_code, l.debit_amount, l.credit_amount, v.created_at, l.line_no
      FROM journal_voucher_lines l
      JOIN journal_vouchers v ON v.id = l.voucher_id AND v.status = 'POSTED' AND v.tenant_id = public.get_tenant_id()
      JOIN chart_of_accounts a ON a.id = l.account_id AND a.control_type IN ('DEBTOR', 'CREDITOR')
     WHERE l.party_id = p_party
  ), brought AS (
    SELECT COALESCE(SUM(debit_amount - credit_amount), 0) AS bf FROM lines WHERE voucher_date < p_from
  ), body AS (
    SELECT voucher_date, voucher_no, vtype, narr, account_code, debit_amount, credit_amount,
           row_number() OVER (ORDER BY voucher_date, created_at, voucher_no, line_no) AS rn
      FROM lines WHERE voucher_date BETWEEN p_from AND p_to
  ), allrows AS (
    SELECT 0::bigint AS rn, p_from AS d, NULL::text AS vno, NULL::text AS vt, 'Brought forward'::text AS narr, NULL::text AS ac,
           GREATEST((SELECT bf FROM brought), 0) AS dr, GREATEST(-(SELECT bf FROM brought), 0) AS cr
     WHERE EXISTS (SELECT 1 FROM parties WHERE id = p_party AND tenant_id = public.get_tenant_id())
    UNION ALL
    SELECT rn, voucher_date, voucher_no, vtype, narr, account_code, debit_amount, credit_amount FROM body
  )
  SELECT rn, d, vno, vt, narr, ac, dr, cr,
         round(SUM(dr - cr) OVER (ORDER BY rn ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW), 2)
    FROM allrows ORDER BY rn
$$;

-- stock on hand as on a date, valued at each batch's landed cost (same basis as the books use)
CREATE OR REPLACE FUNCTION public.rpt_stock_valuation(p_as_of date)
RETURNS TABLE (product_id uuid, product_name text, product_code text, category text, location_id uuid, location_name text,
               batch_id uuid, batch_number text, expiry_date date, qty numeric, unit_cost numeric, value numeric)
LANGUAGE sql STABLE AS $$
  WITH mv AS (
    SELECT sl.product_id, sl.batch_id,
           CASE WHEN sl.movement_type IN ('SALE','RETURN_TO_SUPPLIER','TRANSFER_OUT','QUARANTINE_HOLD','ADJ_DECREASE','EXPIRY_WRITE_OFF','DAMAGE_WRITE_OFF','FMS_SUBSIDY_OUT')
                THEN COALESCE(sl.from_location_id, sl.to_location_id) ELSE COALESCE(sl.to_location_id, sl.from_location_id) END AS loc,
           CASE WHEN sl.movement_type IN ('GRN','OPENING','RETURN_FROM_SALE','TRANSFER_IN','QUARANTINE_RELEASE','ADJ_INCREASE','FMS_RETURN') THEN sl.qty
                WHEN sl.movement_type IN ('SALE','RETURN_TO_SUPPLIER','TRANSFER_OUT','QUARANTINE_HOLD','ADJ_DECREASE','EXPIRY_WRITE_OFF','DAMAGE_WRITE_OFF','FMS_SUBSIDY_OUT') THEN -sl.qty
                ELSE 0 END AS q
      FROM stock_ledger sl
     WHERE sl.tenant_id = public.get_tenant_id() AND sl.is_reversal = FALSE AND sl.movement_date <= p_as_of
  ), bal AS (
    SELECT product_id, batch_id, loc, SUM(q) AS q FROM mv GROUP BY product_id, batch_id, loc HAVING SUM(q) <> 0
  )
  SELECT p.id, p.name, p.product_code, p.category::text, bal.loc, l.name, b.id, b.batch_number, b.expiry_date, bal.q,
         round(COALESCE(b.landing_cost_per_unit, b.purchase_rate, 0), 4),
         round(bal.q * COALESCE(b.landing_cost_per_unit, b.purchase_rate, 0), 2)
    FROM bal
    JOIN products p ON p.id = bal.product_id
    LEFT JOIN batch_register b ON b.id = bal.batch_id
    LEFT JOIN locations l ON l.id = bal.loc
   ORDER BY p.name, l.name, b.batch_number
$$;

-- how long each batch has been sitting: age from its first receipt, plus days to expiry
CREATE OR REPLACE FUNCTION public.rpt_stock_ageing(p_as_of date)
RETURNS TABLE (product_id uuid, product_name text, location_name text, batch_id uuid, batch_number text, received_on date,
               age_days int, age_bucket text, expiry_date date, days_to_expiry int, expiry_status text, qty numeric, value numeric)
LANGUAGE sql STABLE AS $$
  WITH first_in AS (
    SELECT batch_id, MIN(movement_date) AS d FROM stock_ledger
     WHERE tenant_id = public.get_tenant_id() AND is_reversal = FALSE AND movement_type IN ('GRN','OPENING','ADJ_INCREASE','RETURN_FROM_SALE')
     GROUP BY batch_id
  )
  SELECT v.product_id, v.product_name, v.location_name, v.batch_id, v.batch_number, COALESCE(f.d, p_as_of),
         GREATEST(p_as_of - COALESCE(f.d, p_as_of), 0)::int,
         CASE WHEN p_as_of - COALESCE(f.d, p_as_of) <= 30 THEN '0-30'
              WHEN p_as_of - COALESCE(f.d, p_as_of) <= 60 THEN '31-60'
              WHEN p_as_of - COALESCE(f.d, p_as_of) <= 90 THEN '61-90'
              WHEN p_as_of - COALESCE(f.d, p_as_of) <= 180 THEN '91-180'
              ELSE '180+' END,
         v.expiry_date,
         CASE WHEN v.expiry_date IS NULL THEN NULL ELSE (v.expiry_date - p_as_of)::int END,
         CASE WHEN v.expiry_date IS NULL THEN 'NO_EXPIRY' WHEN v.expiry_date < p_as_of THEN 'EXPIRED'
              WHEN v.expiry_date <= p_as_of + 90 THEN 'EXPIRING_90' ELSE 'OK' END,
         v.qty, v.value
    FROM public.rpt_stock_valuation(p_as_of) v
    LEFT JOIN first_in f ON f.batch_id = v.batch_id
   WHERE v.qty > 0
   ORDER BY 6, v.product_name
$$;

GRANT EXECUTE ON FUNCTION public.rpt_account_balances(date), public.rpt_account_ledger(uuid, date, date), public.rpt_party_statement(uuid, date, date),
  public.rpt_stock_valuation(date), public.rpt_stock_ageing(date) TO authenticated;

-- value of goods dispatched on a stock transfer and not yet received: they have left the source location but are
-- still the company's stock (and still in account 1020), so the valuation report shows them as their own line.
CREATE OR REPLACE FUNCTION public.rpt_stock_in_transit(p_as_of date)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT COALESCE(round(SUM(
           CASE WHEN sl.movement_type = 'TRANSFER_OUT' THEN sl.qty WHEN sl.movement_type = 'TRANSFER_IN' THEN -sl.qty ELSE 0 END
           * COALESCE(NULLIF(sl.rate_per_unit, 0), b.landing_cost_per_unit, b.purchase_rate, 0)), 2), 0)
    FROM stock_ledger sl
    LEFT JOIN batch_register b ON b.id = sl.batch_id
   WHERE sl.tenant_id = public.get_tenant_id() AND sl.is_reversal = FALSE AND sl.movement_date <= p_as_of
     AND sl.movement_type IN ('TRANSFER_OUT', 'TRANSFER_IN')
$$;
GRANT EXECUTE ON FUNCTION public.rpt_stock_in_transit(date) TO authenticated;
