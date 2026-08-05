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
# 1. Dependencies + build + install the `plaid-sync` command
npm install          # `prepare` compiles to dist/ automatically
npm link             # puts `plaid-sync` on your PATH

# 2. Postgres
docker compose up -d

# 3. Config
cp .env.example .env
plaid-sync keygen    # prints ENCRYPTION_KEY=... — paste it into .env
```

`npm link` symlinks this directory, so `plaid-sync` works from anywhere and
picks up `.env`, `schema.sql` and `public/` from the project. After editing
source, run `npm run build` — the link points at `dist/`, which does not
rebuild itself.

Then fill in `PLAID_CLIENT_ID` and `PLAID_SECRET` in `.env`. `DATABASE_URL` is
already pointed at the docker container. Set `CRON_SECRET` to any long random
string (`openssl rand -base64 32`) — it is unused locally but keeps `.env`
consistent with production.

```bash
# 4. Create the tables
plaid-sync migrate

# 5. Connect a bank — opens on http://127.0.0.1:4000
plaid-sync link

# 6. Pull transactions
plaid-sync sync
```

`plaid-sync link` stays running so you can link several banks; stop it with
`Ctrl-C` when you are done. The first `plaid-sync sync` backfills up to 24 months
of history (however much the bank actually holds) and takes a while; every run
after that only fetches changes and takes seconds.

> **First sync came back empty?** Plaid pulls history asynchronously. If the
> summary says `Plaid still preparing history`, wait a minute and run
> `plaid-sync sync` again.

### Test with sandbox first

Recommended before pointing at real accounts. In `.env`:

```bash
PLAID_ENV=sandbox
PLAID_SECRET=<your sandbox secret>   # different from the production one
```

Then `plaid-sync link` and pick any institution — log in with username `user_good`
and password `pass_good`. If prompted for MFA, use `1234`. You get a realistic
set of fake accounts and transactions to verify the whole pipeline against.

Sandbox and production access tokens are not interchangeable, so switching
`PLAID_ENV` means wiping and re-linking. See
[Switching environments](#switching-environments).

---

## Deleting data

Two destructive commands. Both refuse to run unattended and both spell out which
environment and database they are about to touch.

```bash
plaid-sync reset               # delete everything: banks, accounts, transactions
plaid-sync reset --revoke   # ...and invalidate each access token at Plaid
plaid-sync reset --data-only # keep the bank links, drop synced data + cursors
plaid-sync unlink              # pick one bank to remove
plaid-sync unlink chase --revoke
```

### Local delete vs. revoke

These are different, and conflating them is how you end up paying for Items you
thought were gone:

| | Local delete (default) | `--revoke` |
| --- | --- | --- |
| Rows in this database | deleted | deleted |
| Access token stored here | destroyed | destroyed |
| Item at Plaid | **still exists, still billed** | invalidated, permanently |
| To restore | `plaid-sync link` | `plaid-sync link` |

Without `--revoke` the Item keeps counting against your Plaid plan even though
your database is empty. Use `--revoke` when you are truly finished with a bank —
or remove it from the [Plaid dashboard](https://dashboard.plaid.com/) later.

A failed revoke never blocks the local delete: you get a loud warning and the
rows still go, so a dead credential can't wedge the database.

### The confirmation

```
  ⚠  DELETE ALL LOCAL DATA

     Environment       PRODUCTION
     Database          plaid_sync @ localhost:5432  (local docker)
     Banks             3
     Accounts          7
     Transactions      4182
     Revoke at Plaid   YES — tokens invalidated

     • All 3 bank link(s), 7 account(s) and 4182 transaction(s) are deleted.
     • Stored access tokens are destroyed — `plaid-sync link` is required for every bank.
     • Each token is also invalidated at Plaid (/item/remove). Irreversible.

Type "production" to confirm:
```

You type the **environment name**, not `y`. A confirmation you can satisfy by
reflex is not a confirmation, and this way a production wipe cannot be confirmed
with the same keystrokes as a sandbox one. The database line is there to catch
the "I thought I was pointed at the docker container" mistake.

`-y` / `--yes` skips the prompt for scripts. Without it, a non-interactive shell
refuses outright rather than guessing.

### Switching environments

Sandbox and production tokens are not interchangeable, so moving between them is
a wipe-and-relink:

```bash
plaid-sync reset --revoke      # clean slate; sandbox tokens invalidated
# edit .env:  PLAID_ENV=production  and the matching PLAID_SECRET
plaid-sync link                   # re-link each bank against production
plaid-sync sync                   # full history backfill
```

Keep the same `ENCRYPTION_KEY` unless you have a reason to rotate it — changing
it makes any surviving stored token undecryptable.

> Wiping the whole database instead (`docker compose down -v`) also works, but
> it drops the schema, so you would need `plaid-sync migrate` again. `plaid-sync reset`
> leaves the tables in place.

---

## Verifying it worked

Quickest check — what is connected and how fresh it is:

```bash
plaid-sync status
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
plaid-sync txns                       # fully interactive — no flags needed
plaid-sync txns --all -d 90        # every account, 90 days, no prompts
plaid-sync txns checking           # match by name/mask/id, then prompt for window
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

Choosing **All accounts** lists every account together with an extra column
identifying which one each transaction belongs to, and totals grouped by
currency. The bank name is hidden while only one institution is linked, and
reappears automatically once there are two.

Run `plaid-sync txns --help` (or `plaid-sync status --help`) for full usage.

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

**Confirming idempotency:** run `plaid-sync sync` twice. The second run should
report `+0 added, ~0 modified, -0 removed`, and this should be unchanged:

```sql
SELECT COUNT(*) FROM transactions;
```

---

## Scheduling locally

`plaid-sync sync` exits non-zero if any item failed, so cron can alert on it.

```bash
crontab -e
```

```cron
# 08:00 daily. Absolute path — cron gets almost no environment and will not
# find `plaid-sync` on PATH. Get yours with: command -v plaid-sync
0 8 * * * /Users/jonathankomorek/.nvm/versions/node/v24.19.0/bin/plaid-sync sync >> /tmp/plaid-sync.log 2>&1
```

No `cd` needed: the binary locates `.env` and `schema.sql` from the project
itself. Note that cron will not wake a sleeping Mac; if the machine is often
asleep, prefer `launchd` with `StartInterval`, or just move to Vercel Cron.

Docker must be running for the local database to be reachable — add
`restart: unless-stopped` (already set in `docker-compose.yml`) and enable
"Start Docker Desktop on login".

---

## Moving to Next.js on Vercel

The split is already done: everything in `src/` is portable, everything in
`cli/` is the local binary and stays behind.

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
it and run `plaid-sync migrate` once, or paste `schema.sql` into the provider's SQL
console.

**Test it:**

```bash
curl -i -H "Authorization: Bearer $CRON_SECRET" https://your-app.vercel.app/api/sync
```

### What about linking new banks after the move?

The Link flow does not have to move with it. Run `plaid-sync link` locally against
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
│   ├── remove.ts            # unlink / reset primitives
│   └── index.ts             # barrel export
├── cli/                     # the plaid-sync binary (not portable, not needed)
│   ├── index.ts             # entry: env, argv parsing, pool teardown
│   ├── <command>.ts         # one file per subcommand
│   ├── paths.ts             # locates schema.sql / public/ in any layout
│   ├── env.ts               # .env discovery
│   ├── confirm.ts           # destructive-command gate
│   └── format.ts            # money / dates / truncation
├── dist/                    # build output — what `bin` points at (gitignored)
├── public/index.html        # the Plaid Link page
├── nextjs-example/          # reference cron route (excluded from tsconfig)
├── schema.sql
├── docker-compose.yml
└── vercel.json
```

`src/` never imports from `cli/`. That boundary is what lets `src/` be copied
into a Next.js app without dragging commander, dotenv, express or clack along.

### Commands

`plaid-sync` with no arguments prints the catalog, along with the environment
and database currently configured. `plaid-sync <command> --help` for per-command
flags.

| Command | Does |
| --- | --- |
| `plaid-sync keygen` | Print a fresh base64 32-byte `ENCRYPTION_KEY` |
| `plaid-sync migrate` | Apply `schema.sql` (idempotent) |
| `plaid-sync link` | Start the local Plaid Link server |
| `plaid-sync sync` | Sync all banks; exits 1 if any failed |
| `plaid-sync status` | Linked banks, balances, freshness (`--json` for monitoring) |
| `plaid-sync txns` | Recent transactions — interactive pickers (default 7 days) |
| `plaid-sync unlink` | Remove one bank and its data (**destructive**) |
| `plaid-sync reset` | Delete all local data (**destructive**) |

Global flags: `--config <path>` to read a different `.env`, `--version`, `--help`.

> `--config`, not `--env-file`: `--env-file` is a **Node** CLI flag, and node
> consumes it out of the argument list before this program ever runs.

### Development

| Command | Does |
| --- | --- |
| `npm run build` | Compile to `dist/` (also runs automatically on `npm install`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run cli -- <command>` | Run from source via tsx, without rebuilding |

### Configuration lookup

`plaid-sync` finds its settings in this order, first hit wins:

1. Real environment variables — `PLAID_ENV=sandbox plaid-sync status` works
2. `--config <path>`
3. `./.env` in the current directory
4. `.env` in the project directory

Steps 3–4 are why the command works from anywhere under `npm link`. If you
install with `npm install -g .` instead, the copied package has no `.env` — use
real environment variables or `--config`. The banner on `plaid-sync` tells you
which file was actually loaded.

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
| `ITEM_LOGIN_REQUIRED` | The bank needs re-authentication. The item's `status` is set to `login_required` and it is skipped until repaired — re-link it via `plaid-sync link`. |
| Sync reports 0 transactions on a new item | Plaid is still pulling history in the background (`NOT_READY`). Run `plaid-sync sync` again shortly. |
| `Failed to decrypt access token` | `ENCRYPTION_KEY` does not match the key the tokens were stored with. |
| `INVALID_API_KEYS` | `PLAID_SECRET` does not match `PLAID_ENV` — sandbox and production have different secrets. |
| `ECONNREFUSED ... 5432` | `docker compose up -d` not running, or another Postgres is already on port 5432 (change the host port in `docker-compose.yml` and `DATABASE_URL`). |
| `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` | Handled automatically — pagination restarts from the stored cursor, up to 5 times. |
