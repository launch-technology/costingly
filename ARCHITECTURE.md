# Architecture

Costingly is a personal RAG pipeline for financial data. It installs a Postgres,
applies a schema to it, pulls transactions from Plaid into it, and exposes the
result to a person (CLI) and to a model (MCP).

Those are four jobs, and the tree separates them into **three layers**.

```
apps/       UX per interface — CLI commands and their formatting,
            MCP tools and their prose
   ↓
domain/     costingly's logic — services (including the Plaid Link page both
            interfaces need), repositories, the schema, the Plaid source
   ↓
platform/   runtime, local Postgres, the pipeline engine, config, crypto,
            profile, ports. No costingly knowledge at all.
```

`platform/` could be repurposed as-is for a second RAG pipeline over a different
API. `domain/` is what makes this one costingly. `apps/` is how a human or a
model reaches it.

## The rules

**R1 — Dependencies point down only.** `apps → domain → platform`. Nothing
imports upward, and the two apps never import each other.

**R2 — A folder name says what something *is*, never what it talks to.** This
is why there is no `shared/`: it would name the audience. The same defect made
the old `src/plaid/` wrong — it held a repository, an API client, three services
and a web server, four kinds filed under a vendor.

**R3 — No interface performs a write.** Reads for display may live in a command
or a tool: a `status` listing is not a use case, and routing it through a service
would add a file that only forwards. A write is different — it has invariants and
both interfaces must get the same one — so it goes through a service.

**R4 — The pipeline ends at the database.** Ingestion and serving have different
triggers and different failure modes. `Pipeline` means Plaid → Postgres and
nothing downstream of it; the whole stack is the *foundation*, not the pipeline.

**R5 — One interface's UX belongs to that interface. Shared UX is a service.**
The question is never "does this present something" but "to WHOSE interface".
`commander` and `@clack/prompts` render the terminal experience and mean nothing
to a model, so they stay in `apps/cli`. The Plaid Link page is the opposite: both
interfaces need that exact page and that exact post-back handler, because Plaid
requires a browser round trip. Filing it under one interface would mean writing
it twice, so it is a service — `express` and all. A rule that forced everything
presentational into `apps/` would have produced that duplication, which is why
express is deliberately absent from the banned-package list.

## The three phases of the foundation

Each phase is a platform mechanism driven by domain content.

| Phase | Platform provides | Domain supplies |
| --- | --- | --- |
| 1. Install and run Postgres | `LocalPostgres`, ports, credentials | — |
| 2. Apply the schema | `SchemaProvisioner`, `SchemaDefinition` | the numbered `.sql` migrations |
| 3. Move the data | `Pipeline`, `Source`, `Sink`, `CheckpointStore` | `PlaidSource`, `TransactionsSink`, `ItemCursorStore` |

Phases 1 and 2 are complete and useful with phase 3 absent. The reverse is not
true — which is what "the database is the hub" means.

The composition of all three is `domain/data/default-database.ts`: it builds a
`Database` from a `ConnectionFactory` and costingly's `SchemaDefinition`, and
exports the `db` every service and repository is handed. There is no separate
`Foundation` class — it would only forward to `Database`, and `ensureReady()`
already lives there.

Seeding is deliberately NOT a pipeline. `costingly seed` generates a dataset and
applies it in one transaction; there is no external source, no checkpoint and
nothing to resume, so the pipeline's machinery would be ceremony. It stays a
service.

## How this stays true

Documentation is what people read after the leak. Two mechanisms do the work.

**The compiler, for direction.** `tsconfig.platform.json` and
`tsconfig.domain.json` run in `npm run typecheck`. Under `composite: true` every
file in the program must match the `include` pattern, so an upward import fails
with `TS6307` naming the file.

**`tests/architecture.test.mts`, for everything types cannot say.** Twelve rules:
no `commander` or `@clack/prompts` below `apps/`; `pg` in one folder; one Plaid client;
no interface writing through a repository; no interface importing another; the
barrel unused from inside `src/`; every root folder one of the three names. It
scans import lines as text rather than walking an AST, deliberately — a check
people avoid touching stops being a check.

This file exists so that when one of those fails, the reader knows whether to
fix the code or change the rule.

## Rejected, with the evidence

Keeping this section is the point of the file. Both of these were proposed,
tried, and killed on evidence; without the record they come back every few
months.

**A generic `platform/` extracted from the MCP layer** (2026-08-29). Measured
before committing: the four "platform" tools carried 16 costingly references,
all in tool *description* prose, and the description is most of each file.
Generalising them means writing worse descriptions, which costs model accuracy.
Only `runtime.ts` and `confirmations.ts` — 184 lines of ~1,400 — were genuinely
portable. The layer split now runs *below* `apps/`, so tools stay whole; that
was the failure mode.

**Per-module folders** (`modules/banks`, `modules/seed`). Only two writers exist
and both write the *same* tables — `0002-item-source.sql` adds `source` precisely
to tell them apart — so module boundaries would generate constant cross-module
joins. A `transactions` module is worse still: it has no independent write
authority, it is a read model.

**`embedded-postgres`** (2026-08-27). Its `start()` spawns the postmaster as a
child of the calling process and detects readiness by watching that child's
stderr, so the server's lifetime is tied to whoever started it. Proven by test:
parent exits, server orphaned, connections hang. Costingly needs the database to
outlive whichever client started it — `costingly sync` can exit while the MCP
server is still connected. `pg_ctl` detaches; both entry points just ask
"running? connect : start".

**A dual database transport** (socket on unix, TCP on Windows). Rejected because
it leaves Windows permanently the less-tested path, which is how it broke
unnoticed the first time. One code path: TCP on 127.0.0.1 everywhere.

## Naming

Kinds that recur across the codebase take a filename suffix — `.command.ts`,
`.tool.ts`, `.repository.ts`, `.service.ts` — and once there are enough of them
to group, a folder as well. Folder plus suffix together is correct:
`commands/doctor.command.ts`. One-off modules that are not instances of a
repeating kind stay bare: `banner.ts`, `format.ts`. Avoid a one-file folder.

