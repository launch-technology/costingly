# costingly

Syncs bank and credit-card transactions from [Plaid](https://plaid.com) into a
Postgres database on your own machine.

Beta. Distributed as a Claude Desktop extension and as this source tree — see
[Installing](#installing).

**There is no database to install.** costingly ships real PostgreSQL 18 binaries
as an npm dependency and manages the cluster itself: `initdb` on first use,
`pg_ctl` to start it, and it stays running afterwards. It listens on loopback
only — `127.0.0.1`, on a port it allocates itself — so nothing is reachable from
the network, and the generated password never leaves your profile directory.

**Everything it owns lives in one profile directory** — config, cluster, log.
`COSTINGLY_HOME` names it; with that unset it falls back to the platform's
data directory (`~/Library/Application Support/costingly` on macOS,
`~/.local/share/costingly` on Linux). That single variable is how development, a
sandbox, and a per-test throwaway all get their own fully isolated environment.

**Three layers, dependencies pointing down only** — `apps/` (a CLI and an MCP
server) on `domain/` (costingly's own logic) on `platform/` (the runtime, the
local Postgres, the pipeline engine, which know nothing about costingly). The
compiler and a test suite both enforce it; see [Project layout](#project-layout).

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

## Installing

Two ways, and they can share one profile on the same machine.

**The Claude Desktop extension.** Download `costingly-<version>.mcpb` from the
[releases page](../../releases) and double-click it. Claude Desktop asks for your
Plaid keys during install. This gives you the MCP server — ask Claude about your
spending in plain language — and nothing else: no terminal command, and no way
to uninstall from inside the app yet, so read
[Uninstalling](#uninstalling) before you commit to it.

**From source**, which additionally gives you the `costingly` command. See below.

> This is a beta. It is not on npm; the extension and this repository are the
> only distributions.

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
up `migrations/` and `public/` from the project. After editing source, run
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
<profile>/config.json    credentials and encryption key
<profile>/pg18/          the cluster
<profile>/pg18.log       the postmaster log
```

Back it up, move it, or delete it as a unit. Nothing costingly owns lives
anywhere else — in particular nothing is written into the package directory, so
rebuilding or reinstalling never touches data.

**What protects `config.json` differs by platform**, and it is worth knowing
because that file holds your encryption key and your Plaid credentials.

On macOS and Linux it is written `0600` — owner-only — so it stays private
wherever the profile is, including a world-readable directory.

On Windows there are no POSIX modes and the request is ignored, so the file is
protected by the ACL it inherits from its directory. In the default location
(`%LOCALAPPDATA%`) that grants only you, SYSTEM and Administrators, which is
equivalent. But it means **the location decides**: if you point `COSTINGLY_HOME`
at a shared folder, a network drive or a cloud-synced directory, the file
inherits that folder's permissions and costingly does not narrow them. Keep the
profile somewhere only you can read.

`costingly status` prints the resolved profile, what chose it, and whether each
piece is healthy. It has no side effects — it starts nothing and creates
nothing — so it works when the server won't start, and it is also how you
confirm an uninstall left nothing behind.

**`COSTINGLY_HOME` moves the whole profile.** That single variable is how you
get a second environment — a checkout, a sandbox, a fresh directory per test:

```bash
COSTINGLY_HOME=./.dev costingly init
```

Profiles are fully isolated: separate config, separate cluster, separate
encryption key. Nothing in one can read the other.

**The server starts itself.** The first command that needs the database starts
the postmaster, and it stays running afterwards so that a sync, a `status` and
anything else can use it at the same time. The port is allocated rather than
fixed — the search starts at 54320, well clear of the 5432 a Postgres you
already run would be on — and it binds loopback only, so nothing on the network
can reach it. To shut it down:

```bash
costingly stop      # data untouched; the next command starts it again
```

The database needs no configuration at all. The port is allocated on first use
and recorded in the profile, and the roles and their passwords are generated
there too — so there is nothing to set and nothing that can disagree with where
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

     Profile           costingly
     Database          ~/Library/Application Support/costingly/pg18  (on this machine)
     Plaid             PRODUCTION
     Banks             3
     Accounts          7
     Transactions      4182
     Revoke at Plaid   YES — tokens invalidated

     • All 3 bank link(s), 7 account(s) and 4182 transaction(s) are deleted.
     • Stored access tokens are destroyed — `costingly link` is required for every bank.
     • Each token is also invalidated at Plaid (/item/remove). Irreversible.

Type "costingly" to confirm:
```

You type the **profile's name**, not `y`. A confirmation you can satisfy by
reflex is not a confirmation, and the profile is the blast radius — so wiping a
throwaway profile cannot build the muscle memory that wipes your real one. The
database line names the cluster about to be emptied, which is what catches the
"I thought I was pointed at the sandbox" mistake.

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

> `costingly reset` keeps the profile and only empties the tables. To remove
> costingly entirely, see [Uninstalling](#uninstalling).

---

## Uninstalling

```bash
costingly uninstall               # remove the Items at Plaid, then delete the profile
costingly uninstall --local-only  # delete the profile; never contact Plaid
```

Four steps, each gated on the one before:

1. **Remove each bank at Plaid** (`/item/remove`), so nothing keeps billing
2. **Stop the database server**
3. **Prove it stopped** — if anything still answers on the profile's port, it
   aborts here and deletes nothing
4. **Delete the profile directory** — config, encryption key, cluster, log

It cannot remove the program itself, and says so when it finishes.

**Revoking is the default here, unlike `reset`.** Uninstall destroys the access
tokens *and* the key that decrypts them, and Plaid can neither reissue a token
nor look one up from an `item_id`. An Item whose token is gone can never be used
again — only paid for. `--local-only` leaves exactly that behind, which is
sometimes what you want (re-installing shortly) and is never silent about it.

### Doing it by hand

If you installed only the Claude Desktop extension, you have no CLI. The
sequence matters:

1. **Quit Claude Desktop.**
2. **Check the database is really stopped.** It will not be. `pg_ctl` starts the
   postmaster detached so it survives whichever process launched it — quitting
   the app does not stop it.

   ```bash
   # macOS / Linux
   ps ax | grep '[p]ostgres.*costingly'
   ```
   ```powershell
   # Windows
   Get-Process postgres -ErrorAction SilentlyContinue
   ```
3. **Stop it** — the postmaster is the process with no `--forkchild` argument;
   the others are its children and will follow it down.

   ```bash
   kill -INT <pid>                                  # macOS / Linux
   ```
   ```powershell
   & "<extension>\node_modules\@embedded-postgres\windows-x64\native\bin\pg_ctl.exe" kill INT <pid>
   ```

   Do not force-kill it (`kill -9`, `taskkill /F`): that skips the shutdown that
   releases shared memory, and does not bring the child processes down with it.
4. **Delete the profile directory** — the paths under
   [Where the data lives](#where-the-data-lives).
5. **Remove the Items at Plaid** yourself, at [my.plaid.com](https://my.plaid.com/)
   or the [Plaid dashboard](https://dashboard.plaid.com/activity/usage). Nothing
   revoked them, and they keep billing until you do.

> **Do not skip to step 4.** Deleting the directory under a running server does
> not fail — on Windows the files unlink while the postmaster holds them open,
> so it keeps serving a database that no longer exists on disk, and
> `postmaster.pid` goes with the rest, leaving nothing that can stop it. That is
> the exact failure `costingly uninstall` refuses to perform.

---

## Verifying it worked

Quickest check — what is connected and how fresh it is:

```bash
costingly status
```

```
Northlake Credit Union  ·  sample data — not a real bank, never synced
  item seed-item-northlake  ·  last synced: never
    Everyday Checking ••4471       depository/checking         $7,842.16    335 txns  2024-08-03 → 2026-08-03
    Rainy Day Savings ••8820       depository/savings         $21,460.88     49 txns  2024-08-03 → 2026-08-03

Cardinal Bank Card Services  ·  sample data — not a real bank, never synced
  item seed-item-cardinal  ·  last synced: never
    Cash Rewards Card ••3092       credit/credit card          $1,919.50   1240 txns  2024-08-03 → 2026-08-03

Vantage One Financial  ·  sample data — not a real bank, never synced
  item seed-item-vantage  ·  last synced: never
    Travel Signature Card ••7715   credit/credit card             $36.04     95 txns  2024-08-31 → 2026-07-31

3 bank(s), 4 account(s), 1719 transaction(s)
PostgreSQL 18 running at ~/Library/Application Support/costingly/pg18
```

The `status`, account-picker and transaction samples in this section come from a
seeded demo profile rather than a real bank, so you can reproduce them — `--seed`
and `--end-date` pin the generator, which is otherwise anchored to today:

```bash
COSTINGLY_HOME=~/costingly-demo costingly seed --seed 20260101 --end-date 2026-08-03
COSTINGLY_HOME=~/costingly-demo costingly status
COSTINGLY_HOME=~/costingly-demo costingly txns "cash rewards"
```

`--days` windows are measured from today, so the transaction sample shows the
seven days ending at that pinned `--end-date`.

It flags anything needing attention — an item that has never synced, or one whose
login expired and needs re-linking. It never decrypts an access token.

The same command answers where everything lives and whether it is healthy. Each
of the three sections reports independently, so a dead database or an
unreachable Plaid never hides the others.

### Recent transactions for one account

```bash
costingly txns                       # fully interactive — no flags needed
costingly txns --all -d 90        # every account, 90 days, no prompts
costingly txns checking           # match by name/mask/id, then prompt for window
```

Run it bare and it asks two questions, both arrow-key driven:

```
◆  Select an account
│  ● Everyday Checking ••4471          $7,842.16    335 txns
│  ○ Rainy Day Savings ••8820         $21,460.88     49 txns
│  ○ Cash Rewards Card ••3092          $1,919.50   1240 txns
│  ○ Travel Signature Card ••7715         $36.04     95 txns
│  ○ All accounts                  4 accounts combined
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
Cardinal Bank Card Services · Cash Rewards Card ••3092 (credit/credit card)
Last 7 day(s) · balance $1,919.50

  2026-08-03  QUEENS BAR 86 E GRAND RIVER AVE DETROIT…       -$85.69  FOOD_AND_DRINK
  2026-08-03  Amazon                                        -$205.94  GENERAL_MERCHANDISE  PENDING
  2026-08-02  Wegmans                                       -$175.32  FOOD_AND_DRINK
  2026-08-02  DoorDash                                       -$22.20  FOOD_AND_DRINK       PENDING
  2026-08-02  Amazon                                        -$160.33  GENERAL_MERCHANDISE
  2026-07-31  SQ *BAKED & WIRED                              -$25.66  FOOD_AND_DRINK
  2026-07-31  Amazon                                        -$144.85  GENERAL_MERCHANDISE
  2026-07-30  SQ *BLUE BOTTLE COFFEE                         -$22.46  FOOD_AND_DRINK
  2026-07-30  Starbucks                                      -$17.05  FOOD_AND_DRINK
  2026-07-29  QUEENS BAR 16 E GRAND RIVER AVE DETROIT…       -$73.07  FOOD_AND_DRINK
  2026-07-28  AMC ONLINE 160743                              -$63.68  ENTERTAINMENT
  2026-07-27  Chipotle                                       -$32.81  FOOD_AND_DRINK
  2026-07-27  QUEENS BAR 91 E GRAND RIVER AVE DETROIT…       -$62.69  FOOD_AND_DRINK

  13 transaction(s)
    USD: in $0.00 · out $1,091.75 · net -$1,091.75
```

Note the sign: this view flips Plaid's convention so it reads like a bank
statement (**negative = money out**). The database itself stores Plaid's
convention, where those same amounts are positive — see the top of
`migrations/0001-initial.sql`.

### Running your own SQL

It is a normal Postgres server, so any Postgres client works. `costingly status`
prints the port and the profile; the roles and their passwords are in
`config.json` inside it.

```bash
costingly status                    # Database  running ✓  127.0.0.1:54320
psql "postgresql://u_app@127.0.0.1:54320/costingly"
```

The listener is bound to `127.0.0.1`, so it is reachable from this machine only.

`psql` is not bundled — use one you already have. `costingly status` prints the
host and port if you need them.

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

Three layers, and dependencies point **down only**.

```
costingly/
├── src/
│   ├── apps/                # one folder per interface — UX lives here
│   │   ├── cli/             # commander + clack: commands/, ui/, utils/
│   │   └── mcp/             # the MCP server: tools/ and their prose
│   ├── domain/              # what makes this costingly
│   │   ├── config.ts        # Plaid keys + encryption key
│   │   ├── crypto.ts        # AES-256-GCM for access tokens
│   │   ├── project.ts       # the ONLY file below apps/ naming this project
│   │   ├── data/            # repositories, the Plaid client, the database
│   │   ├── pipelines/plaid/ # Source, Sink and CheckpointStore for Plaid
│   │   └── services/        # link, sync, unlink, reset, uninstall, status
│   ├── platform/            # reusable: no costingly knowledge at all
│   │   ├── platform-config.ts   # identity -> profile paths
│   │   ├── config-store.ts      # config.json as a file
│   │   ├── profile.ts           # removing a profile, safely
│   │   ├── postgres/            # the cluster, pools, migrations, types
│   │   ├── pipeline/            # Pipeline, Source, Sink, CheckpointStore
│   │   ├── runtime/             # Application, ApplicationHost, ResourceScope
│   │   └── mcp/                 # McpApplication lifecycle
│   └── index.ts             # barrel — for consumers, never used inside src/
├── migrations/              # numbered .sql, applied in order
├── tests/                   # standalone suites + runner (never published)
├── scripts/                 # dev-only, e.g. setup-sandbox (never published)
├── public/index.html        # the Plaid Link page
├── dist/                    # build output — what `bin` points at (gitignored)
├── manifest.json            # the MCP bundle descriptor
└── package.json
```

**`apps` → `domain` → `platform`, never upward, and the two apps never import
each other.** `platform/` could be lifted into a different project as-is — it is
handed an identity and resolves everything from it, so the word "costingly"
appears nowhere below `domain/project.ts`.

That is enforced, not just documented: `tsconfig.platform.json` and
`tsconfig.domain.json` run in `npm run typecheck` and fail an upward import with
`TS6307`, and `tests/architecture.test.mts` checks the rules types cannot
express. See [ARCHITECTURE.md](ARCHITECTURE.md) for why the layers are where
they are — including the two extractions that were tried and rejected.

`package.json` `files` publishes `dist`, `migrations` and `public` only — so
`tests/` and `scripts/` exist for contributors and never reach a tarball.
`migrations/` and `public/` are read at runtime, which is why they must ship.

### Commands

`costingly` with no arguments prints the catalog, along with the environment
and database currently configured. `costingly <command> --help` for per-command
flags.

| Command | Does |
| --- | --- |
| `costingly migrate` | Apply pending migrations (idempotent) |
| `costingly link` | Start the local Plaid Link server |
| `costingly sync` | Sync all banks; exits 1 if any failed |
| `costingly status` | Linked banks, balances, freshness (`--json` for monitoring) |
| `costingly txns` | Recent transactions — interactive pickers (default 7 days) |
| `costingly unlink` | Remove one bank and its data (**destructive**) |
| `costingly reset` | Delete all local data (**destructive**) |
| `costingly stop` | Shut down the database server (data untouched) |
| `costingly uninstall` | Remove everything on this machine (**destructive**) |

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
lives inside it. `costingly status` reports any setting that is missing.

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
| `npm run build:bundle` | Pack `build/costingly-<version>.mcpb` for Claude Desktop |

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

### What this trusts

Worth being explicit, because this holds credentials to your bank data.

**It trusts your user account.** Everything costingly protects is protected
against *other* accounts on the machine and against a leaked copy of the
database file. Nothing is protected against someone already running as you: the
encryption key sits beside the ciphertext it decrypts, because a key you have to
type on every sync is a key nobody keeps.

**It trusts Plaid.** Your bank credentials are entered inside Plaid's own window
and never reach this program. What costingly stores is an `access_token` — a
permanent bearer credential Plaid honours until it is revoked.

**Your Plaid keys are account-wide.** The `client_id` and secret in
`config.json` authenticate against your whole Plaid account, not just costingly.
Anything holding them can act on every Item you own, including ones other
software created.

**The model can read your transactions.** That is the point of the MCP server.
It reaches them only through `role_readonly` on three views, inside a read-only
transaction, with a statement timeout and a row cap — `access_token_enc` is not
reachable from any of it. But merchant names and descriptions are text written
by third parties and reach the model as output; the server's instructions tell
it to treat them as data, never as instructions.

**Nothing leaves the machine except calls to Plaid.** No telemetry, no analytics,
no remote logging. The database binds `127.0.0.1` only.

### The details

- **Access tokens are encrypted at rest** with AES-256-GCM (`iv.tag.ciphertext`,
  base64). GCM is authenticated, so a tampered or wrongly-keyed value fails
  loudly instead of decrypting to garbage.
- **Secrets live only in the profile** — outside the repo and outside the
  published package, so there is nothing to commit or publish by accident. On
  macOS and Linux `config.json` is mode 0600 in a 0700 directory; on Windows see
  [Where the data lives](#where-the-data-lives) for what protects it there.
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
- **`costingly status` never prints secrets** — it reports them as set or unset.
  It is safe to paste into an issue.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `ITEM_LOGIN_REQUIRED` | The bank needs re-authentication. The item's `status` is set to `login_required` and it is skipped until repaired — re-link it via `costingly link`. |
| Sync reports 0 transactions on a new item | Plaid is still pulling history in the background (`NOT_READY`). Run `costingly sync` again shortly. |
| `Failed to decrypt access token` | The encryption key does not match the one the tokens were stored with. Check `costingly status`. |
| `INVALID_API_KEYS` | Wrong Plaid credentials. Re-run `costingly init`, which verifies them against Plaid before saving anything. |
| `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` | Handled automatically — pagination restarts from the stored cursor, up to 5 times. |
| `The database has not been set up yet` | The cluster exists but has no schema. Run `costingly migrate` (or `costingly init`). |
| Commands hang or the server won't start | `costingly status` first — it reports without starting anything. Then read the postmaster log it points at. |
| `costingly: command not found` after `nvm use` | `npm link` installs into one Node version's `bin`. Re-run `npm link` under the version you switched to. |
