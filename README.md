# costingly

Syncs bank and credit-card transactions from [Plaid](https://plaid.com) into a
Postgres database on your own machine.

Not published yet — this document is for working on it.

**There is no database to install.** costingly ships real PostgreSQL 18 binaries
as an npm dependency and manages the cluster itself: `initdb` on first use,
`pg_ctl` to start it, and it stays running afterwards. It listens on a unix
socket, never a TCP port, and uses peer authentication, so there is no password
anywhere and nothing is reachable over the network.

**Everything it owns lives in one profile directory** — config, cluster, socket,
log. `COSTINGLY_HOME` names it; with that unset it falls back to the platform's
data directory (`~/Library/Application Support/costingly` on macOS,
`~/.local/share/costingly` on Linux). That single variable is how development, a
sandbox, and a per-test throwaway all get their own fully isolated environment.

**`src/` is framework-agnostic** — it depends only on `plaid`, `pg` and Node
built-ins. `cli/` may import from `src/`, never the reverse. That boundary is
what would let the sync logic move to another host without dragging commander,
express and clack along.

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

# 2. Set up credentials and create the database
costingly init

# 3. Connect a bank — opens on http://127.0.0.1:4000
costingly link

# 4. Pull transactions
costingly sync
```

`costingly init` prompts for your Plaid keys, verifies them against Plaid before
writing anything, generates an encryption key, and creates the database. It is
safe to re-run: an existing encryption key is never replaced, because that
would make every stored access token permanently undecryptable.

`npm link` symlinks this directory, so `costingly` works from anywhere and picks
up `schema.sql` and `public/` from the project. After editing source, run
`npm run build` — the link points at `dist/`, which does not rebuild itself.

To give this checkout its own database rather than sharing your everyday one,
see [Where the data lives](#where-the-data-lives).

`costingly link` stays running so you can link several banks; stop it with
`Ctrl-C` when you are done.

The first `costingly sync` backfills up to 24 months of history (however much
the bank actually holds) and takes a while; every run after that only fetches
changes and takes seconds.

> **First sync came back empty?** Plaid pulls history asynchronously. If the
> summary says `Plaid still preparing history`, wait a minute and run
> `costingly sync` again.

### Where the data lives

Everything costingly owns lives in **one folder** — its profile:

```
~/Library/Application Support/costingly/     macOS
~/.local/share/costingly/                    Linux
%LOCALAPPDATA%\costingly\Data\               Windows
```

```
<profile>/config.json    credentials and encryption key, mode 0600
<profile>/pg18/          the cluster
<profile>/pg18-run/      the unix socket
<profile>/pg18.log       the postmaster log
```

Back it up, move it, or delete it as a unit. Nothing costingly owns lives
anywhere else — in particular nothing is written into the package directory, so
rebuilding or reinstalling never touches data.

`costingly doctor` prints the resolved profile, what chose it, and whether each
piece is healthy. It never connects to the database, so it still works when the
server won't start.

**`COSTINGLY_HOME` moves the whole profile.** That single variable is how you
get a second environment — a checkout, a sandbox, a fresh directory per test:

```bash
COSTINGLY_HOME=./.dev costingly init
```

Profiles are fully isolated: separate config, separate cluster, separate
encryption key. Nothing in one can read the other.

**The server starts itself.** The first command that needs the database starts
the postmaster, and it stays running afterwards so that a sync, a `status` and
anything else can use it at the same time. Nothing binds a TCP port, so it
cannot collide with a Postgres you already run and is not reachable over the
network. To shut it down:

```bash
costingly stop      # data untouched; the next command starts it again
```

The database needs no configuration at all. The connection is derived from the
profile — a unix socket inside it, peer authentication, no host, no port and no
password — so there is nothing to set and nothing that can disagree with where
the cluster actually is.

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
     Database          ~/Library/Application Support/costingly/pg18  (on this machine)
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
with the same keystrokes as a sandbox one. The database line names the cluster
about to be emptied, which is what catches the "I thought I was pointed at the
sandbox profile" mistake.

`-y` / `--yes` skips the prompt for scripts. Without it, a non-interactive shell
refuses outright rather than guessing.

### Starting over

To wipe and re-link from scratch — after losing your encryption key, say, or
just to clear everything out:

```bash
costingly reset --revoke      # clean slate; tokens invalidated at Plaid
costingly link                # re-link each bank
costingly sync                # full history backfill
```

Keep the same encryption key unless you have a reason to rotate it — changing it
makes any surviving stored token undecryptable.

> Deleting the whole profile is the bluntest option: `costingly stop`, then
> remove the directory `costingly doctor` reports. That takes the config and the
> encryption key with it, so the next run starts at `costingly init`. Quote the
> path — on macOS it contains a space. `costingly reset` keeps both and only
> empties the tables.

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
PostgreSQL 18 running at ~/Library/Application Support/costingly/pg18
```

It flags anything needing attention — an item that has never synced, or one whose
login expired and needs re-linking. It never decrypts an access token.

`costingly doctor` answers the other question: where everything lives and whether
it is healthy. It never connects to the database, so unlike `status` it still
works when the server refuses to start.

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
In a non-interactive shell (a pipe, a CI job) there is nobody to answer the prompt,
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
psql "postgresql:///costingly?host=$HOME/Library/Application Support/costingly/pg18-run"

# or, from any profile:
psql "postgresql:///costingly?host=$COSTINGLY_HOME/pg18-run"
```

There is no password: the socket lives in a directory only your account can
read, and the server uses peer authentication, so the OS decides who you are.

`psql` is not bundled — use one you already have. `costingly doctor` prints the
socket path if you need it.

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

## Project layout

```
costingly/
├── src/                     # framework-agnostic core
│   ├── profile.ts           # where the profile is (COSTINGLY_HOME / env-paths)
│   ├── config.ts            # the config.json store
│   ├── server.ts            # the Postgres cluster: initdb, pg_ctl, socket
│   ├── db.ts                # pooled pg.Pool, withTransaction()
│   ├── crypto.ts            # AES-256-GCM for access tokens
│   ├── plaid.ts             # Plaid client + error helpers
│   ├── items.ts             # item/account persistence
│   ├── link.ts              # link token + public token exchange
│   ├── sync.ts              # syncAllItems() — the heart
│   ├── remove.ts            # unlink / reset primitives
│   └── index.ts             # barrel export
├── cli/                     # the costingly binary
│   ├── index.ts             # entry: argv parsing, pool teardown
│   ├── <command>.ts         # one file per subcommand
│   ├── doctor.ts            # where everything is, without touching the database
│   ├── paths.ts             # locates schema.sql / public/ in any layout
│   ├── confirm.ts           # destructive-command gate
│   └── format.ts            # money / dates / truncation
├── tests/                   # standalone suites + runner (never published)
├── scripts/                 # dev-only, e.g. setup-sandbox (never published)
├── public/index.html        # the Plaid Link page
├── dist/                    # build output — what `bin` points at (gitignored)
├── schema.sql
└── package.json
```

`src/` never imports from `cli/`. That boundary is what lets `src/` move to
another host without dragging commander, express or clack along.

`package.json` `files` publishes `dist`, `schema.sql` and `public` only — so
`tests/` and `scripts/` exist for contributors and never reach a tarball.
`schema.sql` and `public/` are read at runtime, which is why they must ship.

### Commands

`costingly` with no arguments prints the catalog, along with the environment
and database currently configured. `costingly <command> --help` for per-command
flags.

| Command | Does |
| --- | --- |
| `costingly migrate` | Apply `schema.sql` (idempotent) |
| `costingly link` | Start the local Plaid Link server |
| `costingly sync` | Sync all banks; exits 1 if any failed |
| `costingly status` | Linked banks, balances, freshness (`--json` for monitoring) |
| `costingly txns` | Recent transactions — interactive pickers (default 7 days) |
| `costingly unlink` | Remove one bank and its data (**destructive**) |
| `costingly reset` | Delete all local data (**destructive**) |
| `costingly stop` | Shut down the database server (data untouched) |
| `costingly doctor` | Where everything lives and whether it's healthy |

Global flags: `--version`, `--help`. To use a different profile, set
`COSTINGLY_HOME`.

### Configuration lookup

Settings resolve in this order, first hit wins:

1. **CLI flags**
2. **Real environment variables** — `PLAID_SECRET=… costingly sync` works, and is
   how CI configures it with no file at all
3. **`config.json`** in the profile — what `costingly init` writes
4. **Defaults in source**

There is no file discovery and nothing relative to the current directory: the
profile is named by `COSTINGLY_HOME` or the platform default, and the config
lives inside it. `costingly doctor` shows every value and which layer supplied
it.

A `.env` in the current directory is loaded if present, purely as a way to set
environment variables in development or CI. costingly never writes one and never
stores credentials in one.

---

## Development

### Sandbox

Plaid's sandbox serves fake institutions and fake transactions. It is a
**contributor-only concern** — nothing about it reaches someone who installs
costingly, and there is no CLI command, flag or config prompt that mentions it.
It exists because `sandboxPublicTokenCreate` is the only way to link a bank
without a human in a browser, which makes it the only way to test the
link → sync → verify pipeline automatically.

One command sets it up:

```bash
npm run setup:sandbox
```

It asks for your Plaid **sandbox** keys (the Sandbox row at
[dashboard.plaid.com/developers/keys](https://dashboard.plaid.com/developers/keys)),
verifies them against the real API, and writes `.dev-sandbox/config.json` —
git-ignored, mode 0600. `PLAID_CLIENT_ID` / `PLAID_SECRET` in the environment
skip the prompts, so CI can run it unattended.

That profile has its own cluster and its own throwaway encryption key, so it
cannot read or write your real transactions. Isolation is by directory, not by a
rule anyone has to remember.

The end-to-end suites skip with instructions until it exists, so a fresh clone
runs everything else green.

`costingly init` cannot create this profile — it always writes
`plaidEnv: "production"`, which is what keeps sandbox out of the product.

In sandbox, Plaid Link accepts `user_good` / `pass_good`, and `1234` for MFA.

### Scripts

| Command | Does |
| --- | --- |
| `npm run build` | Compile to `dist/` (also runs on `npm install`) |
| `npm run typecheck` | `tsc --noEmit`, including `tests/` and `scripts/` |
| `npm run cli -- <command>` | Run from source via tsx, without rebuilding |
| `npm test` | Run every suite |
| `npm test -- <name>` | Run only suites matching `<name>` |
| `npm run setup:sandbox` | Create the `.dev-sandbox` profile the e2e tests need |

`npm link` points the global `costingly` at `dist/`, which does not rebuild
itself — so after editing source, run `npm run build` before the command
reflects it. `npm run cli` skips that by running from source.

### Tests

```
tests/run.mts             the runner
tests/<name>.test.mts     one standalone suite per file
```

No framework. Each suite is a script that asserts, prints its own results and
exits 0 or 1. The runner spawns them in **separate processes**, which is not
incidental: several set `COSTINGLY_HOME` and start real Postgres clusters, so a
shared process would leak one suite's state into the next.

| Suite | Covers |
| --- | --- |
| `profile` | where the profile resolves, and that resolving one touches no disk |
| `config` | the `config.json` store: precedence, file mode, corrupt-file handling, secrets never rendered |
| `smoke` | every module loads under Node ESM; crypto round-trips and rejects tampering |
| `picker` | the interactive account/date pickers, driven through injected streams |
| `confirm` | the destructive-command gate |
| `init-flow` | `costingly init` end to end against the real Plaid API |
| `concurrency` | several OS processes using one database at once |
| `e2e` | link a bank, sync it, prove the sync is idempotent — the whole pipeline |

`init-flow` and `e2e` need Plaid sandbox credentials and **skip with
instructions** when the sandbox profile is missing, so a fresh clone runs
everything else green.

Only failures print output — a green run stays quiet.

---

## Security notes

- **Access tokens are encrypted at rest** with AES-256-GCM (`iv.tag.ciphertext`,
  base64). GCM is authenticated, so a tampered or wrongly-keyed value fails
  loudly instead of decrypting to garbage.
- **Secrets live only in the profile.** `config.json` is written mode 0600 inside a
  0700 directory — outside the repo and outside the published package, so there is
  nothing to commit or publish by accident.
- **Read-only.** Only the `transactions` product is requested — no `auth`
  (account/routing numbers), no `identity`, no `transfer`.
- **Errors are never logged raw.** The Plaid SDK is axios-based and its error
  objects carry the full request config, including your `PLAID-SECRET` header.
  `describeError()` extracts just the Plaid error body; use it instead of
  logging caught errors directly.
- **The Link server binds to `127.0.0.1`.** Its endpoints are unauthenticated —
  do not expose them on a network.
- **Back up the encryption key** somewhere durable (a password manager). It lives
  in `config.json` as `encryptionKey`; losing it means re-linking every bank.
- **`costingly doctor` never prints secrets** — it reports them as set or unset.
  It is safe to paste into an issue.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `ITEM_LOGIN_REQUIRED` | The bank needs re-authentication. The item's `status` is set to `login_required` and it is skipped until repaired — re-link it via `costingly link`. |
| Sync reports 0 transactions on a new item | Plaid is still pulling history in the background (`NOT_READY`). Run `costingly sync` again shortly. |
| `Failed to decrypt access token` | The encryption key does not match the one the tokens were stored with. Check `costingly doctor`. |
| `INVALID_API_KEYS` | Wrong Plaid credentials. Re-run `costingly init`, which verifies them against Plaid before saving anything. |
| `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` | Handled automatically — pagination restarts from the stored cursor, up to 5 times. |
| `The database has not been set up yet` | The cluster exists but has no schema. Run `costingly migrate` (or `costingly init`). |
| Commands hang or the server won't start | `costingly doctor` first — it works without the database. Then read the postmaster log it points at. |
| `socket path is too long` | The profile is nested too deeply; unix sockets cap near 104 bytes. Set `COSTINGLY_HOME` somewhere shorter. |
| `costingly: command not found` after `nvm use` | `npm link` installs into one Node version's `bin`. Re-run `npm link` under the version you switched to. |
