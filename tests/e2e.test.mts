/**
 * Full end-to-end against the REAL Plaid sandbox API, on a throwaway Postgres
 * cluster of its own.
 *
 * Uses /sandbox/public_token/create to skip the browser, then runs the same
 * exchangePublicToken + syncAllItems the CLI runs. No Docker anywhere.
 */

import { fileURLToPath } from "node:url";

/** Repo root, derived from this file — no absolute paths baked in. */
const P = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

import { existsSync, readFileSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { Products, CountryCode } from "plaid";


// Credentials come from the sandbox PROFILE, never the user's own. Sandbox is
// not a mode of the product — it is a separate profile with its own config,
// its own cluster and its own encryption key, so it is structurally incapable
// of touching real data.
const SANDBOX_CONFIG = `${P}/.dev-sandbox/config.json`;
if (!existsSync(SANDBOX_CONFIG)) {
  console.log("");
  console.log("SKIPPED — this suite needs the sandbox profile.");
  console.log("");
  console.log("  npm run setup:sandbox");
  console.log("");
  console.log("  It asks for your Plaid SANDBOX keys (dashboard.plaid.com/developers/keys)");
  console.log("  and writes .dev-sandbox/config.json, which is git-ignored. Sandbox is a");
  console.log("  contributor-only concern — nothing about it ships to users.");
  console.log("");
  process.exit(0);
}
const sandboxConfig = JSON.parse(readFileSync(SANDBOX_CONFIG, "utf8"));
if (sandboxConfig.plaidEnv !== "sandbox") {
  throw new Error(`.dev-sandbox must set plaidEnv "sandbox", got ${sandboxConfig.plaidEnv}`);
}

// Run against a throwaway COPY of that profile, so a failed run never leaves
// the checked-in sandbox profile in a strange state.
//
// Deliberately short and NOT under the scratchpad: the unix socket path derives
// from it, and sockaddr_un caps out near 104 bytes — the scratchpad path alone
// is longer than that.
const HOME = "/tmp/costingly-e2e";
process.env["COSTINGLY_HOME"] = HOME;
mkdirSync(HOME, { recursive: true, mode: 0o700 });
writeFileSync(`${HOME}/config.json`, JSON.stringify(sandboxConfig, null, 2));
chmodSync(`${HOME}/config.json`, 0o600);

const { query, describeDriver } = await import("../src/db/queries.js");
const { closeDb, setMigrationSource } = await import("../src/db/bootstrap.js");
const { getPlaidClient } = await import("../src/plaid/client.js");
const { exchangePublicToken } = await import("../src/plaid/link.js");
const { syncAllItems } = await import("../src/plaid/sync.js");
const { listAllItems } = await import("../src/plaid/items.js");
const { stopServer } = await import("../src/db/server.js");
const { readFile, rm } = await import("node:fs/promises");

// Register the migration loader the way cli/index.ts does, then let the first
// query build the database. Tests take the same path a real install takes.
const { loadMigrations } = await import("../cli/migrations.js");
setMigrationSource(loadMigrations);

/**
 * Wipe the scratch cluster.
 *
 * Stopping first is not optional: deleting PGDATA out from under a live
 * postmaster leaves an orphan process running against a directory that no
 * longer exists, and the next run inherits the mess.
 */
async function wipeScratchCluster(): Promise<void> {
  await stopServer().catch(() => {});
  // One folder holds config, cluster, socket and log — so one rm clears it all,
  // except the config we just planted, which the next line restores.
  await rm(`${HOME}/pg18`, { recursive: true, force: true });
  await rm(`${HOME}/pg18-run`, { recursive: true, force: true });
  await rm(`${HOME}/pg18.log`, { force: true });
}

await wipeScratchCluster();

const out: string[] = [];
let fail = 0;
function eq(a: unknown, b: unknown, what: string): void {
  if (JSON.stringify(a) === JSON.stringify(b)) out.push(`  ok    ${what}`);
  else { fail++; out.push(`  FAIL  ${what}\n          expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
}
function ok(c: boolean, what: string): void { eq(c, true, what); }

out.push(`  --    driver: ${await describeDriver()}`);

// migrate
const t = await query<{ table_name: string }>(
  `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1`);
// schema_migrations is the ledger of which numbered files have run — internal
// bookkeeping, never granted to role_readonly and absent from every view.
eq(t.rows.map(r => r.table_name), ["accounts", "items", "schema_migrations", "transactions"],
   "the migrations ran themselves, with no migrate step");

// real sandbox link, no browser
const plaid = getPlaidClient();
const sandbox = await plaid.sandboxPublicTokenCreate({
  institution_id: "ins_109508",
  initial_products: [Products.Transactions],
  options: { transactions: { days_requested: 365 } },
});
ok(typeof sandbox.data.public_token === "string", "Plaid sandbox issued a public_token");

const linked = await exchangePublicToken(sandbox.data.public_token);
ok(linked.itemId.length > 0, "exchangePublicToken stored an Item");
ok(linked.accountCount > 0, `accounts stored (${linked.accountCount})`);
out.push(`  --    institution: ${linked.institutionName}`);

// token really encrypted at rest
const enc = await query<{ access_token_enc: string }>(`SELECT access_token_enc FROM items LIMIT 1`);
const stored = enc.rows[0]!.access_token_enc;
eq(stored.split(".").length, 3, "access token stored as iv.tag.ciphertext");
ok(!stored.startsWith("access-"), "plaintext token is NOT in the database");
const items = await listAllItems();
eq(items[0]!.source, "plaid", "a linked bank is recorded as source 'plaid'");
ok(items[0]!.accessToken?.startsWith("access-") === true, "token decrypts back out correctly");

// sync #1 — the backfill. Plaid pulls sandbox history asynchronously, so the
// first call can legitimately return NOT_READY with nothing; retry like a user
// would. This exercises the documented "run it again shortly" path.
let run1 = await syncAllItems();
ok(run1.ok, `sync 1 succeeded${run1.ok ? "" : ": " + run1.results[0]?.error}`);
out.push(`  --    sync 1: +${run1.added} added, status=${run1.results[0]?.updateStatus}`);
for (let attempt = 0; attempt < 12; attempt++) {
  const c = await query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM transactions`);
  if (Number(c.rows[0]!.c) > 0) break;
  await new Promise((r) => setTimeout(r, 2500));
  run1 = await syncAllItems();
  out.push(`  --    retry ${attempt + 1}: +${run1.added} added, status=${run1.results[0]?.updateStatus}`);
}
const c1 = await query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM transactions`);
ok(Number(c1.rows[0]!.c) > 0, `transactions written (${c1.rows[0]!.c})`);
if (Number(c1.rows[0]!.c) === 0) {
  console.log(out.join("\n"));
  console.log("\nPlaid never finished the sandbox pull; aborting the column checks.");
  await closeDb(); process.exit(1);
}

// column fidelity through the driver
const row = await query<Record<string, unknown>>(
  `SELECT date, amount, pending, category, pfc, raw, created_at FROM transactions ORDER BY date DESC LIMIT 1`);
const r = row.rows[0]!;
ok(typeof r["date"] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r["date"] as string),
   `DATE is a calendar-day string (${JSON.stringify(r["date"])})`);
ok(typeof r["amount"] === "string", `NUMERIC stays a string (${JSON.stringify(r["amount"])})`);
ok(typeof r["pending"] === "boolean", "BOOLEAN is a boolean");
ok(r["raw"] !== null && typeof r["raw"] === "object", "raw JSONB is an object");
ok(r["created_at"] instanceof Date, "TIMESTAMPTZ is a Date");

// sync #2 — idempotency, the core promise
const before = await query<{ c: string; s: string }>(
  `SELECT COUNT(*)::text AS c, COALESCE(SUM(amount),0)::text AS s FROM transactions`);
const run2 = await syncAllItems();
const after = await query<{ c: string; s: string }>(
  `SELECT COUNT(*)::text AS c, COALESCE(SUM(amount),0)::text AS s FROM transactions`);
eq([run2.added, run2.modified, run2.removed], [0, 0, 0], "sync 2 reports no changes");
eq(after.rows[0]!.c, before.rows[0]!.c, "row count unchanged (sync is IDEMPOTENT)");
eq(after.rows[0]!.s, before.rows[0]!.s, "sum unchanged");
ok(items[0]!.cursor === null, "cursor was null before the first sync");
const after2 = await listAllItems();
ok((after2[0]!.cursor ?? "").length > 0, "cursor persisted after sync");

// persistence across a process-level close/reopen
await closeDb();
// The query string defeats the ESM module cache, forcing a genuinely fresh
// module instance — which is the point of the assertion below.
// The query string defeats the ESM module cache, forcing a genuinely fresh
// module instance — which is the point of the assertion below. TypeScript
// cannot resolve a specifier with a query string, so the type comes from the
// plain path and the specifier is built at runtime.
const REOPEN = "../src/db/queries.js?reopen=1";
const { query: q2 } = (await import(REOPEN)) as typeof import("../src/db/queries.js");
const { closeDb: close2 } = await import("../src/db/bootstrap.js");
const persisted = await q2<{ c: string }>(`SELECT COUNT(*)::text AS c FROM transactions`);
eq(persisted.rows[0]!.c, after.rows[0]!.c, "data survives close/reopen");
await close2();

console.log(out.join("\n"));
console.log(fail === 0 ? `\nAll ${out.filter(l => l.startsWith("  ok") || l.startsWith("  FAIL")).length} checks passed.` : `\n${fail} FAILED.`);
await wipeScratchCluster();
process.exit(fail === 0 ? 0 : 1);
