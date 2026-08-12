-- 073_pt_clients_emergency_phone.sql
--
-- pt_clients.emergency_contact was the only emergency-contact column and
-- was validated/entered as a phone number on the New Client form. Every
-- other module that captures emergency-contact info (PAR-Q, Informed
-- Consent, member enrollment) already models it as a NAME + PHONE pair
-- (emergency_contact / emergency_phone) — informed-consent.routes.js even
-- has a comment noting pt_clients has "no separate phone column". Add the
-- missing column so pt_clients matches that pattern; emergency_contact now
-- holds the contact's name, emergency_phone their number.
--
-- No existing pt_clients row has emergency_contact populated, so there is
-- no legacy data to migrate.

ALTER TABLE pt_clients ADD COLUMN IF NOT EXISTS emergency_phone TEXT;
