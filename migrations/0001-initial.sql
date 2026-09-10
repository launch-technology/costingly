-- ===========================================================================
-- 0001 — initial schema
--
-- The baseline every costingly database starts from. Applied once, recorded in
-- schema_migrations, and never re-run: later changes are their own numbered
-- files in this directory rather than edits to this one.
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

-- ===========================================================================
-- THE VIEW LAYER
--
-- The read surface. Anything querying this database for analysis — the MCP
-- server, a future app, you at a psql prompt — should go through these rather
-- than the tables above.
--
-- Three jobs:
--
--   1. Omit what must not be read. `items.access_token_enc` is the credential
--      for a whole bank login; there is no reason for a reporting query to see
--      it, so it is simply absent here and the `role_readonly` role below has no
--      access to the base table.
--
--   2. Omit what would drown a reader. `transactions.raw` is the full Plaid
--      object per row. `SELECT *` over twenty rows would return twenty JSON
--      blobs — fine for a program, ruinous for anything with a context window.
--
--   3. Carry the meaning. Postgres does NOT propagate a table's COMMENT ON to a
--      view built over it — a view's columns have their own, empty by default.
--      So the comments live here, on the surface people actually query. The
--      `--` comments above are for developers reading this file; these are for
--      anything introspecting the database.
--
-- Deliberately NOT a semantic remodel: `amount` keeps Plaid's sign convention
-- and the comment explains it, rather than the view flipping it and the two
-- disagreeing. The only work these views do is flattening `pfc` and joining the
-- names that every practical query needs.
-- ===========================================================================

DROP VIEW IF EXISTS v_transactions;
DROP VIEW IF EXISTS v_accounts;
DROP VIEW IF EXISTS v_items;

-- ---------------------------------------------------------------------------
CREATE VIEW v_items AS
  SELECT item_id,
         institution_id,
         institution_name,
         status,
         last_synced_at,
         created_at
    FROM items;

COMMENT ON VIEW v_items IS
  'One row per bank LOGIN (Plaid calls it an "Item"), not per account. A single '
  'login can expose several accounts — a checking and a savings at the same bank '
  'share one row here. Join v_accounts to get the accounts.';
COMMENT ON COLUMN v_items.item_id IS 'Plaid Item id. Join key for v_accounts and v_transactions.';
COMMENT ON COLUMN v_items.institution_name IS 'Bank name, e.g. "Bank of America". May be NULL if Plaid did not report it.';
COMMENT ON COLUMN v_items.status IS
  'active | login_required | revoked. Only "active" items are synced; '
  '"login_required" means the bank needs re-authentication and its data is going stale.';
COMMENT ON COLUMN v_items.last_synced_at IS 'When costingly last pulled from this login. NULL means never.';

-- ---------------------------------------------------------------------------
CREATE VIEW v_accounts AS
  SELECT a.account_id,
         a.item_id,
         i.institution_name,
         a.name,
         a.official_name,
         a.mask,
         a.type,
         a.subtype,
         a.currency,
         a.current_balance,
         a.available_balance,
         a.updated_at
    FROM accounts a
    JOIN items i ON i.item_id = a.item_id;

COMMENT ON VIEW v_accounts IS
  'One row per account — a specific card or bank account. institution_name is '
  'joined in so the common case needs no join.';
COMMENT ON COLUMN v_accounts.account_id IS 'Plaid account id. Join key for v_transactions.';
COMMENT ON COLUMN v_accounts.institution_name IS 'Bank name, joined from the login this account belongs to.';
COMMENT ON COLUMN v_accounts.name IS
  'Account name as the bank reports it, e.g. "Joint Account". Free text chosen by '
  'the institution or the user — never assume one, list this view first.';
COMMENT ON COLUMN v_accounts.mask IS 'Last four digits. Combine with name to identify an account to a human.';
COMMENT ON COLUMN v_accounts.type IS 'depository | credit | loan | investment | other.';
COMMENT ON COLUMN v_accounts.subtype IS 'checking | savings | credit card | ... Narrower than type.';
COMMENT ON COLUMN v_accounts.current_balance IS
  'Balance as of the last sync, NOT live. For a credit card this is the amount '
  'OWED, so a larger number is worse.';
COMMENT ON COLUMN v_accounts.available_balance IS 'Balance minus pending holds, or remaining credit. Often NULL.';
COMMENT ON COLUMN v_accounts.updated_at IS 'When the balance above was last written.';

-- ---------------------------------------------------------------------------
CREATE VIEW v_transactions AS
  SELECT t.transaction_id,
         t.account_id,
         t.item_id,
         a.name              AS account_name,
         i.institution_name,
         t.amount,
         t.iso_currency_code AS currency,
         t.date,
         t.authorized_date,
         t.name              AS description,
         t.merchant_name,
         t.pending,
         t.payment_channel,
         t.pfc->>'primary'   AS category,
         t.pfc->>'detailed'  AS category_detailed
    FROM transactions t
    JOIN accounts a ON a.account_id = t.account_id
    JOIN items    i ON i.item_id    = t.item_id;

COMMENT ON VIEW v_transactions IS
  'One row per transaction, with account and institution names joined in. This is '
  'the table to query for spending analysis. READ THE amount COMMENT FIRST — the '
  'sign convention is the opposite of what most people assume.';
COMMENT ON COLUMN v_transactions.amount IS
  'POSITIVE = money OUT (purchases, card spend, debits). NEGATIVE = money IN '
  '(refunds, credits, deposits, paycheques). This is Plaid''s convention, stored '
  'verbatim. SUM(amount) therefore gives NET SPEND for a period, with refunds '
  'cancelling charges. To render a conventional ledger where negative means '
  'spending, negate at read time with -amount.';
COMMENT ON COLUMN v_transactions.date IS
  'The date the transaction POSTED, as a calendar day. Use this for time-based '
  'grouping unless you specifically want when it happened.';
COMMENT ON COLUMN v_transactions.authorized_date IS
  'When the transaction actually occurred, which can be days before it posted. Often NULL.';
COMMENT ON COLUMN v_transactions.pending IS
  'TRUE while the transaction is unsettled. A pending row is later REPLACED by a '
  'settled row with a DIFFERENT transaction_id — so counting both double-counts. '
  'Filter WHERE NOT pending for settled-only analysis.';
COMMENT ON COLUMN v_transactions.category IS
  'Plaid personal_finance_category, primary level — e.g. FOOD_AND_DRINK, '
  'TRANSPORTATION, RENT_AND_UTILITIES. Already flattened out of JSON. NULL when '
  'Plaid did not categorise the transaction. Plaid defines roughly eighty of '
  'these and any one database contains a fraction, so ENUMERATE BEFORE FILTERING: '
  'SELECT DISTINCT category FROM v_transactions ORDER BY 1. NOTE: TRANSFER_IN and '
  'TRANSFER_OUT include movements between your OWN accounts, such as paying a '
  'credit card from checking; counting those as spending double-counts the '
  'original purchase.';
COMMENT ON COLUMN v_transactions.category_detailed IS
  'Narrower category level, e.g. FOOD_AND_DRINK_COFFEE. Far more values than '
  'category, and correspondingly easier to guess wrong — enumerate before filtering.';
COMMENT ON COLUMN v_transactions.description IS 'Raw description from the bank. Messy; prefer merchant_name when set.';
COMMENT ON COLUMN v_transactions.merchant_name IS
  'Plaid''s cleaned-up merchant name. NULL surprisingly often — fall back to '
  'description. Exact spelling is Plaid''s, not the bank''s: match with ILIKE, or '
  'enumerate with SELECT DISTINCT merchant_name, rather than guessing a literal.';
COMMENT ON COLUMN v_transactions.payment_channel IS
  'How the transaction was made — online | in store | other. Enumerate to confirm '
  'which values this database actually uses.';
COMMENT ON COLUMN v_transactions.currency IS 'ISO-4217, e.g. USD. Do not sum across different currencies.';
COMMENT ON COLUMN v_transactions.account_name IS
  'Joined from v_accounts for convenience. Bank-supplied text, so it varies by '
  'institution — enumerate from v_accounts rather than assuming a name.';
COMMENT ON COLUMN v_transactions.institution_name IS
  'Joined from v_items for convenience. Enumerate from v_items rather than '
  'assuming which banks are linked.';

-- ---------------------------------------------------------------------------
-- Roles.
--
-- Three identities, and the split is the point:
--
--   u_superuser    created by initdb, not here. Owns the cluster. Used for
--                  provisioning and migrations only, never pooled.
--   u_app          every tool, every CLI path, every query this codebase
--                  writes. Read and write on the tables; NO DDL. `RESET ROLE`
--                  on one of its connections returns to itself, so nothing an
--                  LLM can reach has a ladder back to superuser.
--   role_readonly  no login at all. u_app is a member and drops into it with
--                  SET LOCAL ROLE for one transaction — see queryReadOnly.
--
-- role_readonly is granted on the VIEWS only. A query running as it cannot
-- reach the base tables, which is what makes access_token_enc genuinely
-- unreachable rather than merely absent from a view definition. Verified: even
-- a superuser is restricted after SET ROLE.
--
-- Passwords are not set here. SQL files are committed; secrets are not. The
-- application generates them and applies them with ALTER ROLE after this runs.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'role_readonly') THEN
    CREATE ROLE role_readonly NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'u_app') THEN
    CREATE ROLE u_app LOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO role_readonly, u_app;
GRANT SELECT ON v_items, v_accounts, v_transactions TO role_readonly;

-- The application's reach: data, never structure.
GRANT SELECT, INSERT, UPDATE, DELETE ON items, accounts, transactions TO u_app;
GRANT SELECT ON v_items, v_accounts, v_transactions TO u_app;
GRANT SELECT, INSERT ON schema_migrations TO u_app;

-- Without this, SET LOCAL ROLE role_readonly fails and the query tool breaks.
GRANT role_readonly TO u_app;

-- Tables added by later migrations are granted automatically. Without this the
-- next migration ships a table the application cannot read, and it fails at
-- runtime rather than at migration time.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO u_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO u_app;
