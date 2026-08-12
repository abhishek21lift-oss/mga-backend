-- ============================================================
-- 142_user_id_columns_are_text.sql
-- Two columns hold a user id but were declared UUID. User ids in this schema
-- are TEXT ('usr-superadmin-001'), so both throw on the first write:
--
--   invalid input syntax for type uuid: "usr-superadmin-001"
--
-- WHAT BROKE
-- Approving a UPI subscription payment. subscription.activate() inserts into
-- subscription_payments with recorded_by = actor.id. Postgres rejected the
-- value, the transaction aborted, checkout.approve() rolled the request back
-- to AWAITING_VERIFICATION as designed, and the operator got a bare
-- "An internal error occurred" — a 500 with no clue what was wrong, on the
-- one screen where money changes hands.
--
-- WHY NOBODY HIT IT SOONER
-- Both columns are still empty. subscription_payments.recorded_by has been
-- UUID since 099_subscription_foundation.sql, where the comment beside it
-- reads "super-admin user id" — the intent was right and the type was wrong,
-- and nothing enforced the difference. Every payment recorded before this
-- point went through a path that passed NULL, so the mismatch never
-- surfaced. platform_announcements.created_by is the same mistake and would
-- have 500'd identically the first time an operator published an
-- announcement.
--
-- Both tables have zero rows and neither column carries a foreign key, so the
-- type change is a plain rewrite with nothing to migrate. Every sibling
-- actor column in the schema is already TEXT
-- (subscription_events.actor_id, subscription_payment_requests.reviewed_by,
-- platform_billing_settings.updated_by); this brings the last two into line.
--
-- src/__tests__/user-id-columns.test.js fails the build if a future migration
-- declares another one as UUID.
-- ============================================================

ALTER TABLE subscription_payments
  ALTER COLUMN recorded_by TYPE TEXT USING recorded_by::TEXT;

ALTER TABLE platform_announcements
  ALTER COLUMN created_by TYPE TEXT USING created_by::TEXT;

-- refresh_tokens.user_id is declared UUID in 047 but is already TEXT on the
-- live database — corrected out of band, with no migration recording it. The
-- guard makes the tracked schema agree with reality without rewriting a table
-- that is already correct, so a fresh environment ends up where this one
-- already is. Dropping and recreating the FK is only needed if the type
-- actually changes, which on any environment matching production it will not.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'refresh_tokens'
       AND column_name = 'user_id' AND data_type = 'uuid'
  ) THEN
    ALTER TABLE refresh_tokens DROP CONSTRAINT IF EXISTS refresh_tokens_user_id_fkey;
    ALTER TABLE refresh_tokens ALTER COLUMN user_id TYPE TEXT USING user_id::TEXT;
    ALTER TABLE refresh_tokens
      ADD CONSTRAINT refresh_tokens_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  END IF;
END $$;
