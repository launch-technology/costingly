-- ===========================================================================
-- plaid-sync schema
--
-- Applied by `npm run migrate`. Every statement is IF NOT EXISTS / idempotent,
-- so re-running the migration is safe.
--
-- ---------------------------------------------------------------------------
-- PLAID SIGN CONVENTION  (important — it is the opposite of what most people
-- expect, and it is the #1 source of wrong-looking dashboards):
--
--     transactions.amount > 0  =>  money OUT of the account
--                                  purchases, debits, card spend, payments out
--     transactions.amount < 0  =>  money IN to the account
--                                  refunds, credits, deposits, paycheques
--
-- So a $42.10 coffee-shop charge is stored as  42.10, and a $42.10 refund of
-- that charge is stored as  -42.10.  To get "net spend" for a period you can
-- simply SUM(amount): the refunds cancel the charges.
--
-- To render a conventional ledger (negative = spend), flip the sign at read
-- time with -amount. Do NOT flip it on write: keeping Plaid's raw convention
-- means the `raw` JSONB column and the `amount` column never disagree.
--
-- Note that for credit cards the same rule holds from the account's point of
-- view: a purchase increases what you owe and is positive; a payment to the
-- card is money leaving the card balance and is negative.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- items — one row per bank login (a Plaid "Item"). One Item can expose several
-- accounts (e.g. a checking + savings + credit card at the same bank).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS items (
  item_id           TEXT PRIMARY KEY,
  institution_id    TEXT,
  institution_name  TEXT,

  -- Plaid access_token, encrypted at rest with AES-256-GCM.
  -- Format: "iv.tag.ciphertext", each part base64. See src/crypto.ts.
  -- Never stored or logged in plaintext.
  access_token_enc  TEXT        NOT NULL,

  -- /transactions/sync cursor. NULL means "never synced" — Plaid then returns
  -- the full available history on the next call (the initial backfill).
  cursor            TEXT,

  -- 'active' | 'login_required' | 'revoked'. Only 'active' items are synced.
  status            TEXT        NOT NULL DEFAULT 'active',

  last_synced_at    TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- accounts — the individual accounts belonging to an Item. Balances are
-- refreshed on every sync from the `accounts` array that /transactions/sync
-- returns alongside the transaction changes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  account_id        TEXT PRIMARY KEY,
  item_id           TEXT        NOT NULL REFERENCES items (item_id) ON DELETE CASCADE,
  name              TEXT,
  official_name     TEXT,
  mask              TEXT,          -- last 4 digits, e.g. '0000'
  type              TEXT,          -- depository | credit | loan | investment | other
  subtype           TEXT,          -- checking | savings | credit card | ...
  currency          TEXT,          -- ISO-4217, e.g. 'USD'
  current_balance   NUMERIC(20, 4),
  available_balance NUMERIC(20, 4),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS accounts_item_id_idx ON accounts (item_id);

-- ---------------------------------------------------------------------------
-- transactions — one row per Plaid transaction, keyed on transaction_id so
-- that re-running a sync is idempotent (added/modified both upsert).
--
-- `pending` transactions are replaced by a settled transaction with a NEW
-- transaction_id; Plaid sends the pending one in `removed` at that point, so
-- this table self-heals without any extra work.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transactions (
  transaction_id    TEXT PRIMARY KEY,
  account_id        TEXT        NOT NULL REFERENCES accounts (account_id) ON DELETE CASCADE,
  item_id           TEXT        NOT NULL REFERENCES items (item_id)       ON DELETE CASCADE,

  -- See the sign convention note at the top of this file:
  -- positive = money out, negative = money in.
  amount            NUMERIC(20, 4) NOT NULL,
  iso_currency_code TEXT,

  date              DATE        NOT NULL,  -- post date
  authorized_date   DATE,                  -- when the transaction was authorized

  name              TEXT,                  -- raw description from the bank
  merchant_name     TEXT,                  -- Plaid's cleaned-up merchant name
  pending           BOOLEAN     NOT NULL DEFAULT FALSE,
  payment_channel   TEXT,                  -- online | in store | other

  category          JSONB,                 -- legacy category hierarchy (array)
  pfc               JSONB,                 -- personal_finance_category {primary, detailed, ...}

  -- Full Plaid transaction object, verbatim. Keeping this means new Plaid
  -- fields are never lost even though the columns above are a subset, and you
  -- can backfill a new column from `raw` without re-syncing.
  raw               JSONB       NOT NULL,

  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS transactions_account_id_idx ON transactions (account_id);
CREATE INDEX IF NOT EXISTS transactions_date_idx       ON transactions (date DESC);
CREATE INDEX IF NOT EXISTS transactions_pending_idx    ON transactions (pending);

-- Handy for per-item reporting and for the summary query in the README.
CREATE INDEX IF NOT EXISTS transactions_item_id_idx    ON transactions (item_id);
