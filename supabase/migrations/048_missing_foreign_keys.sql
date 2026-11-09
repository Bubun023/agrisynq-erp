-- ============================================================
-- Migration 048: missing foreign keys found by running the real app
-- FertiLedger ERP
-- ============================================================
-- The accounting pages embed the related party (PostgREST needs a foreign key to follow a relationship).
-- payment_receipts.party_id and journal_voucher_lines.party_id were plain UUID columns, so the Payment Receipts
-- page crashed with "Could not find a relationship between 'payment_receipts' and 'parties'".
-- Orphans are cleared first so the migration cannot fail on stray data.

UPDATE journal_voucher_lines SET party_id = NULL
 WHERE party_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM parties p WHERE p.id = journal_voucher_lines.party_id);

ALTER TABLE payment_receipts
  ADD CONSTRAINT payment_receipts_party_id_fkey FOREIGN KEY (party_id) REFERENCES parties(id);
ALTER TABLE journal_voucher_lines
  ADD CONSTRAINT journal_voucher_lines_party_id_fkey FOREIGN KEY (party_id) REFERENCES parties(id);

CREATE INDEX IF NOT EXISTS idx_jvl_party ON journal_voucher_lines(party_id) WHERE party_id IS NOT NULL;
