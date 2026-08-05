# costingly

Daily sync of bank and credit-card transactions from [Plaid](https://plaid.com)
into a Postgres database on your own machine.

**Nothing to install but Node.** Costingly ships real PostgreSQL 18 as an
ordinary npm dependency and runs it for you — no Docker, no Homebrew, nothing to
configure. It listens on a unix socket in your home directory, never a network
port, and there is no database password because your OS account *is* the
credential. Your transactions never leave your computer.

The core in `src/` is framework-agnostic, so the same code also runs against a
hosted Postgres on Vercel Cron. See
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

**Prerequisites:** Node 20+, and Plaid API keys from the
[Plaid dashboard](https://dashboard.plaid.com/developers/keys). **No database to
install** — see [Where the data lives](#where-the-data-lives).

```bash
# 1. Dependencies + build + install the `costingly` command
npm install          # `prepare` compiles to dist/ automatically
npm link             # puts `costingly` on your PATH

# 2. Config
cp .env.example .env
costingly keygen    # prints ENCRYPTION_KEY=... — paste it into .env
```

`npm link` symlinks this directory, so `costingly` works from anywhere and
picks up `.env`, `schema.sql` and `public/` from the project. After editing
source, run `npm run build` — the link points at `dist/`, which does not
rebuild itself.

Then fill in `PLAID_CLIENT_ID` and `PLAID_SECRET` in `.env`. Leave
`DATABASE_URL` unset — the embedded database needs no configuration. Set
`CRON_SECRET` to any long random string (`openssl rand -base64 32`) — it is
unused locally but keeps `.env` consistent with production.

```bash
# 4. Create the tables
costingly migrate

# 5. Connect a bank — opens on http://127.0.0.1:4000
costingly link

# 6. Pull transactions
costingly sync
```

`costingly link` stays running so you can link several banks; stop it with
`Ctrl-C` when you are done. The first `costingly sync` backfills up to 24 months
of history (however much the bank actually holds) and takes a while; every run
after that only fetches changes and takes seconds.

> **First sync came back empty?** Plaid pulls history asynchronously. If the
> summary says `Plaid still preparing history`, wait a minute and run
> `costingly sync` again.

### Where the data lives

A real PostgreSQL 18 cluster that costingly creates and runs for you:

```
~/.local/share/costingly/pg18        the cluster
~/.local/share/costingly/pg18-run    the unix socket (mode 0700)
~/.local/share/costingly/pg18.log    the postmaster log
```

Back it up by copying the cluster directory; reset by deleting it.
`XDG_DATA_HOME` is honoured, and `COSTINGLY_DATA_DIR` overrides the location
outright. The `pg18` in the name is deliberate — a Postgres data directory
belongs to one major version, so a future upgrade lands beside this one rather
than failing against it.

**The server starts itself.** The first command that needs the database starts
the postmaster, and it stays running afterwards so that a sync, a `status` and
anything else can use it at the same time. Nothing binds a TCP port, so it
cannot collide with a Postgres you already run and is not reachable over the
network. To shut it down:

```bash
costingly stop      # data untouched; the next command starts it again
```

Because it is genuinely Postgres, the schema and every query are identical to
what a hosted deployment runs — which is why setting `DATABASE_URL` is all it
takes to point the same commands at Neon, Supabase or Vercel Postgres instead:

```bash
DATABASE_URL=postgresql://user:pass@host/db costingly sync
```

Leave it unset and you get the embedded database. That single switch is what
keeps the zero-install local story and the serverless deployment story from
being two different codebases.

---

## Deleting data

Two destructive commands. Both refuse to run unattended and both spell out which
environment and database they are about to touch.

```bash
costingly reset               # delete everything: banks, accounts, transactions
costingly reset --revoke   # ...and invalidate each access token at Plaid
costingly reset --data-only # keep the bank links, drop synced data + cursors
costingly unlink              # pick one bank to remove
costingly unlink chase --revoke
```

### Local delete vs. revoke

These are different, and conflating them is how you end up paying for Items you
thought were gone:

| | Local delete (default) | `--revoke` |
| --- | --- | --- |
| Rows in this database | deleted | deleted |
| Access token stored here | destroyed | destroyed |
| Item at Plaid | **still exists, still billed** | invalidated, permanently |
| To restore | `costingly link` | `costingly link` |

Without `--revoke` the Item keeps counting against your Plaid plan even though
your database is empty. Use `--revoke` when you are truly finished with a bank —
or remove it from the [Plaid dashboard](https://dashboard.plaid.com/) later.

A failed revoke never blocks the local delete: you get a loud warning and the
rows still go, so a dead credential can't wedge the database.

### The confirmation

```
  ⚠  DELETE ALL LOCAL DATA

     Environment       PRODUCTION
     Database          ~/.local/share/costingly/pg18  (local, on this machine)
     Banks             3
     Accounts          7
     Transactions      4182
     Revoke at Plaid   YES — tokens invalidated

     • All 3 bank link(s), 7 account(s) and 4182 transaction(s) are deleted.
     • Stored access tokens are destroyed — `costingly link` is required for every bank.
     • Each token is also invalidated at Plaid (/item/remove). Irreversible.

Type "production" to confirm:
```

You type the **environment name**, not `y`. A confirmation you can satisfy by
reflex is not a confirmation, and this way a production wipe cannot be confirmed
with the same keystrokes as a sandbox one. The database line is there to catch
the "I thought I was pointed at my local copy" mistake — a remote database is
labelled `(REMOTE)`.

`-y` / `--yes` skips the prompt for scripts. Without it, a non-interactive shell
refuses outright rather than guessing.

### Starting over

To wipe and re-link from scratch — after losing your `ENCRYPTION_KEY`, say, or
just to clear everything out:

```bash
costingly reset --revoke      # clean slate; tokens invalidated at Plaid
costingly link                # re-link each bank
costingly sync                # full history backfill
```

Keep the same `ENCRYPTION_KEY` unless you have a reason to rotate it — changing
it makes any surviving stored token undecryptable.

> Deleting the data directory instead (`rm -rf ~/.local/share/costingly`) also
> works, but it drops the schema, so you would need `costingly migrate` again.
> `costingly reset` leaves the tables in place.

---

## Verifying it worked

Quickest check — what is connected and how fresh it is:

```bash
costingly status
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
costingly txns                       # fully interactive — no flags needed
costingly txns --all -d 90        # every account, 90 days, no prompts
costingly txns checking           # match by name/mask/id, then prompt for window
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

Run `costingly txns --help` (or `costingly status --help`) for full usage.

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

### Running your own SQL

It is a normal Postgres server, so any Postgres client works — point it at the
socket directory:

```bash
psql "postgresql:///costingly?host=$HOME/.local/share/costingly/pg18-run"
```

There is no password: the socket lives in a directory only your account can
read, and the server uses peer authentication, so the OS decides who you are.

`psql` is not bundled — use one you already have, or set `DATABASE_URL` to point
costingly at your own Postgres instead. The schema is identical either way, so
every query below works unchanged.

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

**Confirming idempotency:** run `costingly sync` twice. The second run should
report `+0 added, ~0 modified, -0 removed`, and this should be unchanged:

```sql
SELECT COUNT(*) FROM transactions;
```

---

## Scheduling locally

`costingly sync` exits non-zero if any item failed, so cron can alert on it.

```bash
crontab -e
```

```cron
# 08:00 daily. Absolute path — cron gets almost no environment and will not
# find `costingly` on PATH. Get yours with: command -v costingly
0 8 * * * /Users/jonathankomorek/.nvm/versions/node/v24.19.0/bin/costingly sync >> /tmp/costingly.log 2>&1
```

No `cd` needed: the binary locates `.env` and `schema.sql` from the project
itself. Note that cron will not wake a sleeping Mac; if the machine is often
asleep, prefer `launchd` with `StartInterval`, or just move to Vercel Cron.

Nothing else needs to be running: the database is embedded in the command
itself, so there is no daemon to keep alive and nothing to start at login.

---

## Moving to Next.js on Vercel

The split is already done: everything in `src/` is portable, everything in
`cli/` is the local binary and stays behind.

**1. Copy the core.** Move `src/` into your Next.js repo, e.g. `lib/costingly/`.
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
it and run `costingly migrate` once, or paste `schema.sql` into the provider's SQL
console.

**Test it:**

```bash
curl -i -H "Authorization: Bearer $CRON_SECRET" https://your-app.vercel.app/api/sync
```

### What about linking new banks after the move?

The Link flow does not have to move with it. Run `costingly link` locally against
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
costingly/
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
├── cli/                     # the costingly binary (not portable, not needed)
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
└── vercel.json
```

`src/` never imports from `cli/`. That boundary is what lets `src/` be copied
into a Next.js app without dragging commander, dotenv, express or clack along.

### Commands

`costingly` with no arguments prints the catalog, along with the environment
and database currently configured. `costingly <command> --help` for per-command
flags.

| Command | Does |
| --- | --- |
| `costingly keygen` | Print a fresh base64 32-byte `ENCRYPTION_KEY` |
| `costingly migrate` | Apply `schema.sql` (idempotent) |
| `costingly link` | Start the local Plaid Link server |
| `costingly sync` | Sync all banks; exits 1 if any failed |
| `costingly status` | Linked banks, balances, freshness (`--json` for monitoring) |
| `costingly txns` | Recent transactions — interactive pickers (default 7 days) |
| `costingly unlink` | Remove one bank and its data (**destructive**) |
| `costingly reset` | Delete all local data (**destructive**) |

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

`costingly` finds its settings in this order, first hit wins:

1. Real environment variables — `DATABASE_URL=… costingly status` works
2. `--config <path>`
3. `./.env` in the current directory
4. `.env` in the project directory

Steps 3–4 are why the command works from anywhere under `npm link`. If you
install with `npm install -g .` instead, the copied package has no `.env` — use
real environment variables or `--config`. The banner on `costingly` tells you
which file was actually loaded.

---

## Development

### Sandbox

Plaid's sandbox serves fake institutions and fake transactions. It is **not a
product feature** — users always run against production, and there is no
environment setting in `.env` at all. It exists so the end-to-end test, and
anyone contributing, can exercise the real Plaid API without touching real
accounts or paying for Items.

It lives entirely in its own config file:

```bash
cp .env.sandbox.example .env.sandbox   # then fill in your sandbox secret
```

That file carries a complete configuration — including its own
`COSTINGLY_DATA_DIR`, so sandbox gets a **separate database** and can never read
or write your real transactions, and its own throwaway `ENCRYPTION_KEY`, so it
cannot decrypt anything of yours.

The end-to-end suite loads it by path. Any command can be pointed at it too:

```bash
costingly --config .env.sandbox status
```

In sandbox, Plaid Link accepts `user_good` / `pass_good`, and `1234` for MFA.

Without `.env.sandbox`, the end-to-end test skips rather than fails — everything
else still runs.

### Commands

| Command | Does |
| --- | --- |
| `npm run build` | Compile to `dist/` (also runs on `npm install`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run cli -- <command>` | Run from source via tsx, without rebuilding |

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
| `ITEM_LOGIN_REQUIRED` | The bank needs re-authentication. The item's `status` is set to `login_required` and it is skipped until repaired — re-link it via `costingly link`. |
| Sync reports 0 transactions on a new item | Plaid is still pulling history in the background (`NOT_READY`). Run `costingly sync` again shortly. |
| `Failed to decrypt access token` | `ENCRYPTION_KEY` does not match the key the tokens were stored with. |
| `INVALID_API_KEYS` | Wrong `PLAID_CLIENT_ID` / `PLAID_SECRET`. Re-run `costingly init`, which verifies them against Plaid before saving. |
| `ECONNREFUSED ... 5432` | Only possible with `DATABASE_URL` set. Unset it to use the embedded database, or check the server it points at. |
| `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` | Handled automatically — pagination restarts from the stored cursor, up to 5 times. |
