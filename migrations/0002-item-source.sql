-- ===========================================================================
-- 0002 — where an Item's data came from.
--
-- Until now every Item was a Plaid bank login, so "has an access token" and
-- "came from Plaid" were the same statement. They are not the same statement
-- any more: `costingly seed` writes fabricated Items that have no bank behind
-- them, and a future provider (SimpleFIN, say) would have a token that is NOT
-- a Plaid one. So the origin gets said out loud instead of inferred.
--
-- Two values today, both with a caller:
--
--   plaid  a real bank login. Has an access_token. Synced, relinkable,
--          revocable at Plaid.
--   seed   fabricated sample data from `costingly seed`. No token, no bank,
--          never synced. Deleted like any other Item.
--
-- The word is 'seed' rather than 'manual' on purpose. 'manual' would suggest a
-- person typed in real money; these rows are invented, and in a tool that
-- answers "how much did I earn last year" that difference has to be impossible
-- to misread.
-- ===========================================================================

ALTER TABLE items ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'plaid';

ALTER TABLE items DROP CONSTRAINT IF EXISTS items_source_check;
ALTER TABLE items ADD CONSTRAINT items_source_check
  CHECK (source IN ('plaid', 'seed'));

-- Seeded Items have no credential to store.
ALTER TABLE items ALTER COLUMN access_token_enc DROP NOT NULL;

-- ...but a Plaid Item without one is a broken row, and that stays enforced by
-- the database rather than by every reader remembering to check. This is what
-- makes dropping NOT NULL above safe: the invariant did not weaken, it got
-- narrower.
ALTER TABLE items DROP CONSTRAINT IF EXISTS items_plaid_needs_token;
ALTER TABLE items ADD CONSTRAINT items_plaid_needs_token
  CHECK (source <> 'plaid' OR access_token_enc IS NOT NULL);

COMMENT ON COLUMN items.source IS
  'plaid | seed. Only ''plaid'' items have an access_token and are ever synced.';

-- ---------------------------------------------------------------------------
-- Surface it on the read layer.
--
-- CREATE OR REPLACE can only append columns, which is why `source` goes last
-- rather than next to `status` where it reads more naturally. Existing column
-- comments survive the replace; only the new one needs writing.
--
-- v_accounts and v_transactions deliberately do NOT carry this. A profile is a
-- directory holding one database, so seeded and real data never share one —
-- the whole database is one or the other, and item_id joins back here for
-- anything that needs to ask.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_items AS
  SELECT item_id,
         institution_id,
         institution_name,
         status,
         last_synced_at,
         created_at,
         source
    FROM items;

COMMENT ON COLUMN v_items.source IS
  'Where this bank''s data came from. "plaid" is a real bank login. "seed" is '
  'fabricated sample data created by `costingly seed` for demos and development '
  '— it corresponds to no real bank, no real money and no real person, and must '
  'never be described to the user as their actual finances.';
