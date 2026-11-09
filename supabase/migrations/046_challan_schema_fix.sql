-- ============================================================
-- Migration 046: delivery_challans schema reconciliation
-- FertiLedger ERP
-- ============================================================
-- Migration 028 declared delivery_challans with CREATE TABLE IF NOT EXISTS, but 025 had already
-- created a different table of that name, so 028's definition (and the columns the Logistics ->
-- Challans screen was written against) never existed. The 025 table is the real one
-- (challan_number, from_location, purpose challan_purpose with 11 permitted-movement purposes,
-- vehicle_number, eway_bill_number, narration ...). This migration:
--   * adds the compliance columns the screen captures that 025 lacked
--     (consignee name/GSTIN, place of supply, driver mobile, distance, bill-to / ship-to parties);
--   * repoints transporter_id to the transporters master (025 pointed it at parties, so no
--     transporter chosen in the UI could ever be saved).
-- The application layer maps names (see actions/logistics.ts).

ALTER TABLE delivery_challans
  ADD COLUMN IF NOT EXISTS consignee_name        text,
  ADD COLUMN IF NOT EXISTS consignee_gstin       text,
  ADD COLUMN IF NOT EXISTS place_of_supply_state text,
  ADD COLUMN IF NOT EXISTS driver_mobile         text,
  ADD COLUMN IF NOT EXISTS distance_km           numeric(8,2),
  ADD COLUMN IF NOT EXISTS bill_to_party_id      uuid REFERENCES parties(id),
  ADD COLUMN IF NOT EXISTS ship_to_party_id      uuid REFERENCES parties(id);

UPDATE delivery_challans SET transporter_id = NULL
 WHERE transporter_id IS NOT NULL AND transporter_id NOT IN (SELECT id FROM transporters);
ALTER TABLE delivery_challans DROP CONSTRAINT IF EXISTS delivery_challans_transporter_id_fkey;
ALTER TABLE delivery_challans
  ADD CONSTRAINT delivery_challans_transporter_id_fkey FOREIGN KEY (transporter_id) REFERENCES transporters(id);
