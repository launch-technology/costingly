## What this changes

<!-- One or two sentences. The diff shows what; say why. -->

Closes #

## What a user would notice

<!-- "Nothing — internal refactor" is a fine answer. If behaviour changes, say
     what someone running costingly will see differently. -->

## Checklist

- [ ] `npm run typecheck` passes (this is also the architectural layering gate)
- [ ] `npm test` passes
- [ ] Docs updated in this PR — README's Commands table, CONTRIBUTING's Tests
      table, or ARCHITECTURE.md, as applicable
- [ ] Touched the bundle (`scripts/build-bundle.mts`, `manifest.json`,
      dependencies)? Installed the CI `mcpb-*` artifact and it started
- [ ] New dependencies (if any) are justified above
- [ ] No credentials, tokens, or real transaction data anywhere in the diff

## Migrations

- [ ] This PR adds no migration
- [ ] It adds an **additive** migration (new table / column / index / view)
- [ ] It **rewrites or removes existing data** — migrations are forward-only, so
      this forces a major version

<!-- The PR title becomes the commit message: this repository squash-merges.
     Write it the way you want it to read in `git log`. -->
