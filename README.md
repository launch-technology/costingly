# plaid-sync

Daily sync of bank and credit-card transactions from [Plaid](https://plaid.com)
into a local Postgres database.

Runs locally today. The core in `src/` is framework-agnostic — it imports only
`plaid`, `pg`, and Node built-ins — so the same code drops into a Next.js app on
Vercel Cron later without a rewrite. See
[Moving to Next.js on Vercel](#moving-to-nextjs-on-vercel).

---

## How it works

Two separate flows:

**1. Link — once per bank login.** A local-only Express server serves a page that
opens Plaid Link. You enter credentials inside Plaid's own window; this app never
sees them. On success the `public_token` is exchanged for a permanent
`access_token`, which is encrypted (AES-256-GCM) and stored along with the
institution and its accounts.

**2. Sync — recurring and idempotent.** For each stored item, `/transactions/sync`
is paged through until `has_more` is false. `added` and `modified` transactions
are upserted on `transaction_id`, `removed` ones are deleted, account balances
are refreshed, and the new cursor is saved — all in **one database transaction
per item**. The cursor advances only if the rows it describes were committed, so
a crash mid-run cannot skip or double-apply changes. Re-running fetches only
what changed.

```
items ──1:N──> accounts ──1:N──> transactions
  │                                    ▲
  └── access_token_enc, cursor ────────┘
      (encrypted)   (resume point for /transactions/sync)
```

### The sign convention (read this once)

Plaid's amounts are the opposite of what most people expect:

| `amount` | Meaning | Examples |
| --- | --- | --- |
| **positive** | money **out** | purchases, card spend, debits |
| **negative** | money **in** | refunds, credits, deposits, paycheques |

Stored verbatim, so `raw` and `amount` never disagree. `SUM(amount)` gives net
spend for a period (refunds cancel charges); flip the sign at read time with
`-amount` if you want a conventional ledger.

---

## Local setup

**Prerequisites:** Node 20+, Docker, and Plaid API keys from the
[Plaid dashboard](https://dashboard.plaid.com/developers/keys).

```bash
# 1. Dependencies
npm install

# 2. Postgres
docker compose up -d

# 3. Config
cp .env.example .env
npm run keygen          # prints ENCRYPTION_KEY=... — paste it into .env
```

Then fill in `PLAID_CLIENT_ID` and `PLAID_SECRET` in `.env`. `DATABASE_URL` is
already pointed at the docker container. Set `CRON_SECRET` to any long random
string (`openssl rand -base64 32`) — it is unused locally but keeps `.env`
consistent with production.

```bash
# 4. Create the tables
npm run migrate

# 5. Connect a bank — opens on http://127.0.0.1:4000
npm run link

# 6. Pull transactions
npm run sync
```

`npm run link` stays running so you can link several banks; stop it with
`Ctrl-C` when you are done. The first `npm run sync` backfills up to 24 months
of history (however much the bank actually holds) and takes a while; every run
after that only fetches changes and takes seconds.

> **First sync came back empty?** Plaid pulls history asynchronously. If the
> summary says `Plaid still preparing history`, wait a minute and run
> `npm run sync` again.

### Test with sandbox first

Recommended before pointing at real accounts. In `.env`:

```bash
PLAID_ENV=sandbox
PLAID_SECRET=<your sandbox secret>   # different from the production one
```

Then `npm run link` and pick any institution — log in with username `user_good`
and password `pass_good`. If prompted for MFA, use `1234`. You get a realistic
set of fake accounts and transactions to verify the whole pipeline against.

Sandbox and production access tokens are not interchangeable. When you switch
`PLAID_ENV`, re-run `npm run link`, and consider starting from a clean database
(`docker compose down -v && docker compose up -d && npm run migrate`) so the two
environments' data does not mix.

---

## Verifying it worked

Quickest check — what is connected and how fresh it is:

```bash
npm run status
```

```
Bank of America
  item pQ5VXlxgB3Fva…  ·  last synced: 2h ago
    Everyday Checking ••4021       depository/checking         $1,234.56    847 txns  2024-08-04 → 2026-08-03
    Sapphire Card ••8899           credit/credit card          $2,104.11    612 txns  2024-08-04 → 2026-08-02

1 bank(s), 2 account(s), 1459 transaction(s)
```

It flags anything needing attention — an item that has never synced, or one whose
login expired and needs re-linking. It never decrypts an access token.

### Recent transactions for one account

```bash
npm run txns                       # fully interactive — no flags needed
npm run txns -- --all -d 90        # every account, 90 days, no prompts
npm run txns -- checking           # match by name/mask/id, then prompt for window
```

Run it bare and it asks two questions, both arrow-key driven:

```
◆  Select an account
│  ● Plaid 401k ••6666         $23,631.98      0 txns
│  ○ Plaid Checking ••0000        $110.00    145 txns
│  ○ All accounts           2 accounts combined
└
◆  How far back?
│  ● Last 7 days
│  ○ Last 14 days
│  ○ Last 30 days
│  ○ Last 90 days
│  ○ Last year
│  ○ All time
└
```

Passing `--days` skips the second prompt, so scripts keep full control while
interactive use needs no flags at all.

> **On `npm run txns -- --days 14`:** the bare `--` is npm's requirement, not
> this tool's — it is the only way `npm run` forwards arguments to a script.
> The interactive prompts above exist so you rarely need it. If you want a
> flagless global command, see [Installing as a command](#installing-as-a-command).

Choosing **All accounts** lists every account together with an extra column
identifying which one each transaction belongs to, and totals grouped by
currency. The bank name is hidden while only one institution is linked, and
reappears automatically once there are two.

Run `npm run txns -- --help` (or `npm run status -- --help`) for full usage.

To skip the menu, pass an account: a loose match against name, mask, account id,
or institution name. One match runs straight away; several re-open the picker.
In a non-interactive shell (cron, a pipe) there is nobody to answer the prompt,
so it prints the candidates and exits instead of hanging.

```
Bank of America · Plaid Checking ••0000 (depository/checking)
Last 30 day(s) · balance $110.00

  2026-07-26  Uber                                          -$6.33  TRANSPORTATION
  2026-07-11  United Airlines                              $500.00  TRAVEL
  2026-07-10  Starbucks                                     -$4.33  FOOD_AND_DRINK

  6 transaction(s) · in $500.00 · out $117.46 · net $382.54
```

Note the sign: this view flips Plaid's convention so it reads like a bank
statement (**negative = money out**). The database itself stores Plaid's
convention, where those same amounts are positive — see the top of `schema.sql`.

### Installing as a command

To drop the `npm run` / `--` ceremony entirely, add aliases to your shell
profile (`~/.bash_profile`, or `~/.zshrc` if you switch shells):

```bash
PLAID_SYNC_DIR="$HOME/Workspaces/Personal-Finances/plaid-sync"
alias txns='(cd "$PLAID_SYNC_DIR" && npm run txns --silent --)'
alias plaid-status='(cd "$PLAID_SYNC_DIR" && npm run status --silent --)'
alias plaid-sync='(cd "$PLAID_SYNC_DIR" && npm run sync --silent)'
```

Then from anywhere:

```bash
txns                  # interactive
txns --days 14        # no `--` needed
txns checking -d 30
```

The subshell `cd` matters: `.env` and `schema.sql` are resolved relative to the
project directory, so the command has to run from there.

For anything beyond that, query the database directly:

```bash
psql postgresql://plaid:plaid@localhost:5432/plaid_sync
```

Recent transactions with their account and institution:

```sql
SELECT t.date,
       i.institution_name           AS bank,
       a.name || ' ••' || a.mask    AS account,
       COALESCE(t.merchant_name, t.name) AS description,
       t.amount,                    -- positive = money out
       t.pending,
       t.pfc->>'primary'            AS category
  FROM transactions t
  JOIN accounts a ON a.account_id = t.account_id
  JOIN items    i ON i.item_id    = t.item_id
 ORDER BY t.date DESC, t.transaction_id
 LIMIT 25;
```

Spend by category over the last 30 days:

```sql
SELECT COALESCE(pfc->>'primary', 'UNCATEGORIZED') AS category,
       COUNT(*)                                   AS txns,
       ROUND(SUM(amount), 2)                      AS net_spend
  FROM transactions
 WHERE date >= CURRENT_DATE - INTERVAL '30 days'
   AND NOT pending
 GROUP BY 1
 ORDER BY net_spend DESC;
```

Current balances:

```sql
SELECT i.institution_name, a.name, a.mask, a.type, a.subtype,
       a.current_balance, a.available_balance, a.currency
  FROM accounts a
  JOIN items i ON i.item_id = a.item_id
 ORDER BY i.institution_name, a.name;
```

**Confirming idempotency:** run `npm run sync` twice. The second run should
report `+0 added, ~0 modified, -0 removed`, and this should be unchanged:

```sql
SELECT COUNT(*) FROM transactions;
```

---

## Scheduling locally

`npm run sync` exits non-zero if any item failed, so cron can alert on it.

```bash
crontab -e
```

```cron
# 08:00 daily. Absolute paths — cron gets almost no environment.
0 8 * * * cd /path/to/plaid-sync && /usr/local/bin/npm run --silent sync >> /tmp/plaid-sync.log 2>&1
```

Find your npm path with `which npm`. Note that cron will not wake a sleeping
Mac; if the machine is often asleep, prefer `launchd` with `StartInterval`, or
just move to Vercel Cron.

Docker must be running for the local database to be reachable — add
`restart: unless-stopped` (already set in `docker-compose.yml`) and enable
"Start Docker Desktop on login".

---

## Moving to Next.js on Vercel

The split is already done: everything in `src/` is portable, everything in
`scripts/` is the local CLI shell.

**1. Copy the core.** Move `src/` into your Next.js repo, e.g. `lib/plaid-sync/`.
No edits needed — it has no Express, no dotenv, no filesystem access. Add `plaid`
and `pg` to that project's dependencies.

**2. Add the route.** Copy [`nextjs-example/app/api/sync/route.ts`](nextjs-example/app/api/sync/route.ts)
to `app/api/sync/route.ts` and fix the import paths to wherever you put `src/`.
It sets `maxDuration = 300` and `dynamic = "force-dynamic"`, and verifies
`Authorization: Bearer $CRON_SECRET`.

**3. Add the cron.** Copy [`vercel.json`](vercel.json):

```json
{ "crons": [{ "path": "/api/sync", "schedule": "0 8 * * *" }] }
```

Vercel Cron **already** sends `Authorization: Bearer $CRON_SECRET` on every
scheduled request, so the route's auth check needs no changes to work in
production — set the env var and it matches.

Schedules run in **UTC**. Hobby allows **up to 2 cron jobs, triggered once per
day**, and Hobby crons may fire at an arbitrary time within the hour you specify.
Pro lifts both limits.

**4. Use a pooled Postgres connection.** This is the step people get wrong.
Serverless functions scale to many concurrent instances, and a direct Postgres
connection string will exhaust the connection limit. Use the **pooled** string
your provider gives you:

| Provider | Use |
| --- | --- |
| Neon | the `-pooler` host (PgBouncer), not the direct one |
| Supabase | the connection pooler on port `6543`, not `5432` |
| Vercel Postgres | `POSTGRES_URL` (pooled), not `POSTGRES_URL_NON_POOLING` |

`src/db.ts` already enables TLS automatically for any non-localhost host and
caches the pool on `globalThis` so warm containers reuse connections.

**5. Set the env vars** in Vercel → Settings → Environment Variables:
`PLAID_CLIENT_ID`, `PLAID_SECRET`, `PLAID_ENV`, `DATABASE_URL`, `ENCRYPTION_KEY`,
`CRON_SECRET`.

> `ENCRYPTION_KEY` must be **the same key** you used locally, or the stored
> access tokens cannot be decrypted and every bank has to be re-linked.

**6. Migrate the schema** against the hosted database — point `DATABASE_URL` at
it and run `npm run migrate` once, or paste `schema.sql` into the provider's SQL
console.

**Test it:**

```bash
curl -i -H "Authorization: Bearer $CRON_SECRET" https://your-app.vercel.app/api/sync
```

### What about linking new banks after the move?

The Link flow does not have to move with it. Run `npm run link` locally against
the production `DATABASE_URL` whenever you add a bank — it is a rare, interactive
operation. Porting it later is straightforward: `src/link.ts` already contains
all the logic, so you would only need two thin route handlers plus a page, and
Plaid would need your production domain registered as an allowed redirect URI.

---

## Optional upgrade: webhooks

Cron on a fixed schedule means new transactions can sit unseen for up to a day.
Plaid can push instead.

Pass a `webhook` URL when creating the link token in `src/link.ts`:

```ts
request.webhook = "https://your-app.vercel.app/api/plaid/webhook";
```

Then add a handler that watches for `SYNC_UPDATES_AVAILABLE` (webhook type
`TRANSACTIONS`) and calls the very same `syncAllItems()`:

```ts
if (body.webhook_type === "TRANSACTIONS" && body.webhook_code === "SYNC_UPDATES_AVAILABLE") {
  await syncAllItems();   // idempotent — safe to call from both cron and webhook
}
```

Because the sync is cursor-driven and idempotent, cron and webhooks can run
side by side: whichever fires first picks up the changes, the other finds
nothing to do. Keep the daily cron as a safety net for missed webhooks.

Verify webhooks in production with `/webhook_verification_key/get` before
trusting their contents — an unauthenticated endpoint that triggers work is
worth protecting.

---

## Project layout

```
plaid-sync/
├── src/                     # framework-agnostic core — portable to Next.js
│   ├── config.ts            # env vars, lazily validated
│   ├── crypto.ts            # AES-256-GCM for access tokens
│   ├── db.ts                # pooled pg.Pool, withTransaction()
│   ├── plaid.ts             # Plaid client + error helpers
│   ├── items.ts             # item/account persistence
│   ├── link.ts              # link token + public token exchange
│   ├── sync.ts              # syncAllItems() — the heart
│   └── index.ts             # barrel export
├── scripts/                 # local CLI shells (not portable, not needed)
│   ├── migrate.ts           # npm run migrate
│   ├── link-server.ts       # npm run link
│   ├── sync.ts              # npm run sync
│   └── keygen.ts            # npm run keygen
├── public/index.html        # the Plaid Link page
├── nextjs-example/          # reference cron route (excluded from tsconfig)
├── schema.sql
├── docker-compose.yml
└── vercel.json
```

### Scripts

| Command | Does |
| --- | --- |
| `npm run migrate` | Apply `schema.sql` (idempotent) |
| `npm run link` | Start the local Plaid Link server |
| `npm run sync` | Sync all items; exits 1 if any failed |
| `npm run status` | Show linked banks, accounts, balances and freshness (`-- --json` for monitoring) |
| `npm run txns` | Recent transactions — interactive account picker (default 7 days) |
| `npm run keygen` | Print a fresh base64 32-byte `ENCRYPTION_KEY` |
| `npm run typecheck` | `tsc --noEmit` |

---

## Security notes

- **Access tokens are encrypted at rest** with AES-256-GCM (`iv.tag.ciphertext`,
  base64). GCM is authenticated, so a tampered or wrongly-keyed value fails
  loudly instead of decrypting to garbage.
- **Secrets live only in env.** `.env` is gitignored; `.env.example` carries no
  values.
- **Read-only.** Only the `transactions` product is requested — no `auth`
  (account/routing numbers), no `identity`, no `transfer`.
- **Errors are never logged raw.** The Plaid SDK is axios-based and its error
  objects carry the full request config, including your `PLAID-SECRET` header.
  `describeError()` extracts just the Plaid error body; use it instead of
  logging caught errors directly.
- **The Link server binds to `127.0.0.1`.** Its endpoints are unauthenticated —
  do not expose them on a network.
- **Back up `ENCRYPTION_KEY`** somewhere durable (a password manager). Losing it
  means re-linking every bank.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `ITEM_LOGIN_REQUIRED` | The bank needs re-authentication. The item's `status` is set to `login_required` and it is skipped until repaired — re-link it via `npm run link`. |
| Sync reports 0 transactions on a new item | Plaid is still pulling history in the background (`NOT_READY`). Run `npm run sync` again shortly. |
| `Failed to decrypt access token` | `ENCRYPTION_KEY` does not match the key the tokens were stored with. |
| `INVALID_API_KEYS` | `PLAID_SECRET` does not match `PLAID_ENV` — sandbox and production have different secrets. |
| `ECONNREFUSED ... 5432` | `docker compose up -d` not running, or another Postgres is already on port 5432 (change the host port in `docker-compose.yml` and `DATABASE_URL`). |
| `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` | Handled automatically — pagination restarts from the stored cursor, up to 5 times. |
