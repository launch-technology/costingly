# nextjs-example

A reference copy of the Vercel Cron route handler. **Nothing here is wired into
the local app** — it is excluded from `tsconfig.json` because it imports
`next/server`, which is not a dependency of this project. It typechecks once it
lives inside a real Next.js repo.

```
app/api/sync/route.ts    GET/POST → verifies CRON_SECRET → syncAllItems()
```

See the "Moving to Next.js on Vercel" section of the top-level [README](../README.md)
for the full migration walkthrough.
