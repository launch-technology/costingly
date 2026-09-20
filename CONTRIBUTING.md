# Contributing

Costingly is maintained by one person. Issues and pull requests are welcome;
replies come in days, not hours.

Before writing code for anything non-trivial, **open an issue first**. This
codebase has a deliberate structure (see [ARCHITECTURE.md](ARCHITECTURE.md)), and
the fastest way to have a pull request rejected is to have built the right thing
in the wrong layer. A three-line issue saves an afternoon.

## Adding a feature

The whole loop, start to finish.

### 1. Start from an up-to-date `main`

```bash
git switch main
git pull
git switch -c feat/budget-summary-tool
```

`main` is always releasable, and every change reaches it through a pull request —
including the maintainer's. Branch names are `<type>/<slug>`:

| Prefix | For |
| --- | --- |
| `feat/` | New behaviour |
| `fix/` | A bug fix |
| `chore/` | Build, CI, dependencies |
| `docs/` | Documentation only |
| `refactor/` | Structure, no behaviour change |
| `test/` | Tests only |

An issue number is optional and goes after the slash: `fix/42-sync-cursor-restart`.
Keep branches short-lived — a branch that lives three weeks is a merge conflict
with extra steps.

### 2. Install — usually nothing to do

**On a fresh clone, once:**

```bash
npm ci
```

**On an existing checkout: skip this step.** Run something only if dependencies
actually changed — if you pulled a branch that touched `package.json`:

```bash
npm install
```

The distinction matters more here than in most projects. `npm ci` **deletes
`node_modules` and reinstalls from scratch**, and this project's tree is ~200 MB,
about 108 MB of which is the embedded PostgreSQL 18 build. It also re-runs the
postinstall that rehydrates PostgreSQL's symlinks. That is a reasonable price
once, to get exactly the tree CI and the release bundle use; it is a waste on
every branch switch. Use `npm install` for day-to-day work — it is incremental,
and it updates the lockfile when you add a dependency, which is what you want.

You need **Node 20 or newer**. You do **not** need PostgreSQL installed —
costingly ships real PostgreSQL 18 binaries as a dependency and manages the
cluster itself. If you have your own PostgreSQL, costingly will not touch it.

One surprise either way: installing compiles the project, because the `prepare`
script runs `npm run build`. So a type error shows up as an *install* failure
rather than a build failure. Confusing exactly once.

### 3. Write the code

Run the CLI from source while you iterate, without rebuilding:

```bash
npm run cli -- status
npm run cli -- sync
```

Two things to know before your first change:

**Dependencies point down only.** `apps/` → `domain/` → `platform/`. An import
that points upward is a build failure, not a review comment — see step 4.

**There is no linter.** Match the style of the file you are editing: two-space
indent, double quotes, semicolons, trailing commas in multi-line literals. And
comments here explain *why*, not *what* — several exist purely to stop a future
reader "fixing" something deliberate.

### 4. Check it locally

```bash
npm run typecheck
npm test
```

**`npm run typecheck` is also the architecture check.** It runs four tsconfigs,
not one. Two of them (`tsconfig.platform.json`, `tsconfig.domain.json`) are
composite projects scoped to a single layer, so an import reaching upward fails
with `TS6307` naming the offending file. If that happens,
[ARCHITECTURE.md](ARCHITECTURE.md) tells you whether to fix the code or change the
rule — it has a "Rejected, with the evidence" section, so check whether your idea
is already in there before proposing a restructure.

`npm test` runs all 18 suites. Eleven of them start a real embedded PostgreSQL
cluster, so the first run is not fast. To run one suite:

```bash
npm test -- views
```

Only failures print output. A green run stays quiet.

**Two suites will say `SKIPPED`** — `e2e` and `init-flow` need Plaid *sandbox*
credentials. That is expected and fine; you can contribute to most of this project
without ever setting them up. If you do need them, see
[The Plaid sandbox](#the-plaid-sandbox) below.

### 5. Open a pull request

```bash
git push -u origin feat/budget-summary-tool
gh pr create --fill
```

**The PR title becomes the commit message.** This repository squash-merges, so
your individual commits are collapsed into one and the title is what lands in
`git log`. Write it that way:

> `add an MCP tool that summarises spend by category and month`

Present tense, lowercase, says what changed. That also means you are free to
commit `wip` and `fix typo` on your branch — nobody will ask you to rebase.

In the description: link the issue (`Closes #42`), say what problem it solves, and
say what a user would notice. "Nothing — internal refactor" is a fine answer.

### 6. CI runs automatically

Four checks, and **all must pass before merge**:

| Check | What it does |
| --- | --- |
| `guard` | Version consistency and a production dependency audit. ~25 seconds |
| `test (ubuntu-latest)` | Typecheck and the full suite on Linux |
| `test (windows-latest)` | The same on Windows, a shipped platform |
| `bundle (win32-x64)` | Builds the installable `.mcpb` |

`guard` runs first and fails fast, so a version mismatch doesn't cost you a
40-minute run.

**The `bundle` job uploads a real `.mcpb` as a build artifact.** If your change
touches the MCP server, the database, or anything a user would feel, download it
from the run's Artifacts section and install it in Claude Desktop. That is the
only way to test what people actually receive.

If you opened the PR **from a fork**, `e2e` and `init-flow` will skip — fork pull
requests cannot read repository secrets, by design. Your run still goes green at
16 of 18 suites. That is not something you need to fix.

### 7. Merge

Squash-merge. The branch is deleted automatically.

That is the end of your part — releases are cut separately by the maintainer, and
you do not need to bump any version numbers.

## The Plaid sandbox

Plaid's sandbox serves fake institutions and fake transactions. It is a
**contributor-only concern** — nothing about it reaches someone who installs
costingly. It exists because `sandboxPublicTokenCreate` is the only way to link a
bank without a human in a browser, which makes it the only way to test the
link → sync → verify pipeline automatically.

```bash
npm run setup:sandbox
```

It asks for your Plaid **sandbox** keys (the Sandbox row at
[dashboard.plaid.com/developers/keys](https://dashboard.plaid.com/developers/keys)),
verifies them against the real API, and writes `.dev-sandbox/config.json` —
git-ignored, mode 0600. That profile has its own cluster and its own throwaway
encryption key, so it cannot read or write your real transactions.

In sandbox, Plaid Link accepts `user_good` / `pass_good`, and `1234` for MFA.

**Never put real Plaid production keys in a test, an issue, or a pull request.**

## A few rules that save review rounds

- **One change per pull request.** A fix and a refactor together get reviewed at
  the speed of the harder half.
- **Update the docs in the same PR.** A new CLI command belongs in README's
  Commands table; a structural change belongs in ARCHITECTURE.md. Documentation
  that lands "in a follow-up" does not land.
- **New dependencies need a reason in the description.** This project ships a
  bundled database and holds bank credentials; every package is both weight and
  attack surface.
- **Say whether your change touches migrations**, and whether the migration is
  *additive* (a new table, column or view) or *rewrites existing data*. Migrations
  are forward-only — there are no down files — so the second kind forces a major
  version and needs to be flagged, not discovered.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

`costingly status` never prints secrets — it reports each as set or unset — so its
output is safe to paste into an issue. Almost nothing else is.
