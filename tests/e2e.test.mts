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


// Credentials come from the sandbox keys file, never the user's own. Sandbox is
// not a mode of the product — the product has no way to reach it. This suite
// builds its OWN Plaid client in sandbox mode from those keys and hands it to
// the code under test, which neither knows nor cares which Plaid it was given.
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

const { db, closeDb } = await import("../src/domain/data/default-database.js");
const { install } = await import("../src/domain/services/install.service.js");
const { PlaidClient } = await import("../src/domain/data/plaid.client.js");
const { exchangePublicToken } = await import("../src/domain/services/banks/link.service.js");
const { syncAllItems } = await import("../src/domain/services/banks/sync.service.js");
const { markItemRepaired } = await import("../src/domain/services/banks/relink.service.js");
const { unlinkBank } = await import("../src/domain/services/banks/unlink.service.js");
const { listAllItems } = await import("../src/domain/data/repositories/items.repository.js");
const { server } = await import("../src/domain/project.js");
const { readFile, rm } = await import("node:fs/promises");

// Register the migration loader the way cli/main.ts does, then let the first
// query build the database. Tests take the same path a real install takes.
const { loadMigrations } = await import("../src/platform/postgres/migrations.js");

/**
 * Wipe the scratch cluster.
 *
 * Stopping first is not optional: deleting PGDATA out from under a live
 * postmaster leaves an orphan process running against a directory that no
 * longer exists, and the next run inherits the mess.
 */
async function wipeScratchCluster(): Promise<void> {
  await server.stop().catch(() => {});
  // One folder holds config, cluster, socket and log — so one rm clears it all,
  // except the config we just planted, which the next line restores.
  await rm(`${HOME}/pg18`, { recursive: true, force: true });
  await rm(`${HOME}/pg18-run`, { recursive: true, force: true });
  await rm(`${HOME}/pg18.log`, { force: true });
}

/**
 * Take the whole throwaway profile with us, config included.
 *
 * `wipeScratchCluster` deliberately spares config.json — the run needs it, and
 * it is planted again on the way in. On the way OUT there is nothing to spare
 * it for, and leaving it behind means a git-ignored copy of the sandbox Plaid
 * keys and an encryption key sitting in a world-readable temp directory until
 * someone notices. A suite cleans up after itself.
 */
async function removeScratchProfile(): Promise<void> {
  await wipeScratchCluster();
  await rm(HOME, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

await wipeScratchCluster();

const out: string[] = [];
let fail = 0;
function eq(a: unknown, b: unknown, what: string): void {
  if (JSON.stringify(a) === JSON.stringify(b)) out.push(`  ok    ${what}`);
  else { fail++; out.push(`  FAIL  ${what}\n          expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
}
function ok(c: boolean, what: string): void { eq(c, true, what); }

out.push(`  --    database: ${db.describe()}`);

// Provisioning is deliberate now: reading no longer builds a database, so a
// test that needs one asks for it exactly as a command does.
await install();

// migrate
const t = await db.query<{ table_name: string }>(
  `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1`);
// schema_migrations is the ledger of which numbered files have run — internal
// bookkeeping, never granted to role_readonly and absent from every view.
eq(t.rows.map(r => r.table_name), ["accounts", "items", "schema_migrations", "transactions"],
   "ensureReady() created the cluster, the database and every table");

// real sandbox link, no browser
// The one place this suite says "sandbox": a client it constructs and injects.
const plaid = PlaidClient.withKeys(sandboxConfig.plaidClientId, sandboxConfig.plaidSecret, "sandbox");
const sandbox = await plaid.api.sandboxPublicTokenCreate({
  institution_id: "ins_109508",
  initial_products: [Products.Transactions],
  options: { transactions: { days_requested: 365 } },
});
ok(typeof sandbox.data.public_token === "string", "Plaid sandbox issued a public_token");

const linked = await exchangePublicToken(plaid, sandbox.data.public_token);
ok(linked.itemId.length > 0, "exchangePublicToken stored an Item");
ok(linked.accountCount > 0, `accounts stored (${linked.accountCount})`);
out.push(`  --    institution: ${linked.institutionName}`);

// token really encrypted at rest
const enc = await db.query<{ access_token_enc: string }>(`SELECT access_token_enc FROM items LIMIT 1`);
const stored = enc.rows[0]!.access_token_enc;
eq(stored.split(".").length, 3, "access token stored as iv.tag.ciphertext");
ok(!stored.startsWith("access-"), "plaintext token is NOT in the database");
const items = await listAllItems(db);
eq(items[0]!.source, "plaid", "a linked bank is recorded as source 'plaid'");
ok(items[0]!.accessToken?.startsWith("access-") === true, "token decrypts back out correctly");

// sync #1 — the backfill. Plaid pulls sandbox history asynchronously, so the
// first call can legitimately return NOT_READY with nothing; retry like a user
// would. This exercises the documented "run it again shortly" path.
let run1 = await syncAllItems(plaid);
ok(run1.ok, `sync 1 succeeded${run1.ok ? "" : ": " + run1.results[0]?.error}`);
out.push(`  --    sync 1: +${run1.added} added, status=${run1.results[0]?.updateStatus}`);
// Wait for the sandbox to SETTLE, not merely to produce a row. Plaid delivers
// the historical pull in instalments, so "some rows arrived" can still be
// followed by hundreds more — and the idempotence check below would then
// measure Plaid still working rather than this code re-applying a batch.
// Settled means: rows exist AND TWO syncs in a row found nothing new. One
// quiet sync is not enough — the sandbox has been seen to report
// HISTORICAL_UPDATE_COMPLETE with nothing new and then deliver 176 more rows
// to the very next call.
let quiet = 0;
for (let attempt = 0; attempt < 16 && quiet < 2; attempt++) {
  const c = await db.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM transactions`);
  quiet = Number(c.rows[0]!.c) > 0 && run1.added === 0 && run1.modified === 0 ? quiet + 1 : 0;
  if (quiet >= 2) break;
  await new Promise((r) => setTimeout(r, 2500));
  run1 = await syncAllItems(plaid);
  out.push(`  --    retry ${attempt + 1}: +${run1.added} added, status=${run1.results[0]?.updateStatus}`);
}
const c1 = await db.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM transactions`);
ok(Number(c1.rows[0]!.c) > 0, `transactions written (${c1.rows[0]!.c})`);
if (Number(c1.rows[0]!.c) === 0) {
  console.log(out.join("\n"));
  console.log("\nPlaid never finished the sandbox pull; aborting the column checks.");
  await closeDb(); process.exit(1);
}

// column fidelity through the driver
const row = await db.query<Record<string, unknown>>(
  `SELECT date, amount, pending, category, pfc, raw, created_at FROM transactions ORDER BY date DESC LIMIT 1`);
const r = row.rows[0]!;
ok(typeof r["date"] === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r["date"] as string),
   `DATE is a calendar-day string (${JSON.stringify(r["date"])})`);
ok(typeof r["amount"] === "string", `NUMERIC stays a string (${JSON.stringify(r["amount"])})`);
ok(typeof r["pending"] === "boolean", "BOOLEAN is a boolean");
ok(r["raw"] !== null && typeof r["raw"] === "object", "raw JSONB is an object");
ok(r["created_at"] instanceof Date, "TIMESTAMPTZ is a Date");

// sync #2 — idempotency, the core promise
const before = await db.query<{ c: string; s: string }>(
  `SELECT COUNT(*)::text AS c, COALESCE(SUM(amount),0)::text AS s FROM transactions`);
const run2 = await syncAllItems(plaid);
const after = await db.query<{ c: string; s: string }>(
  `SELECT COUNT(*)::text AS c, COALESCE(SUM(amount),0)::text AS s FROM transactions`);
eq([run2.added, run2.modified, run2.removed], [0, 0, 0], "sync 2 reports no changes");
eq(after.rows[0]!.c, before.rows[0]!.c, "row count unchanged (sync is IDEMPOTENT)");
eq(after.rows[0]!.s, before.rows[0]!.s, "sum unchanged");
ok(items[0]!.cursor === null, "cursor was null before the first sync");
const after2 = await listAllItems(db);
ok((after2[0]!.cursor ?? "").length > 0, "cursor persisted after sync");

// --- a login that expires ----------------------------------------------------
// The sandbox can force this on demand; a real bank cannot. It is the one
// failure a sync reacts to rather than just reporting: the bank is marked, and
// left alone until the user reconnects it.
const linkedItem = (await listAllItems(db))[0]!;
await plaid.api.sandboxItemResetLogin({ access_token: linkedItem.accessToken! });

const expired = await syncAllItems(plaid);
eq([expired.itemsTotal, expired.results[0]?.ok], [1, false], "with the login expired, the sync reports that bank as failed");
ok(
  /\bITEM_LOGIN_REQUIRED\b/.test(expired.results[0]?.error ?? ""),
  `and the reason carries Plaid's code for it (${expired.results[0]?.error})`,
);
eq((await listAllItems(db))[0]!.status, "login_required", "THE BANK IS MARKED AS NEEDING ITS LOGIN RENEWED");

const skipped = await syncAllItems(plaid);
eq(skipped.itemsTotal, 0, "AND THE NEXT SYNC LEAVES IT ALONE rather than failing on it again");

// Reconnecting is done in Plaid's form, which no test can drive. What it ends
// with is this call, and what that must do is return the bank to the syncable
// set — after which Plaid decides. The sandbox login is still expired, so the
// next sync marks it again, which is the documented behaviour for a repair
// that did not take.
await markItemRepaired(linkedItem.itemId);
eq((await listAllItems(db))[0]!.status, "active", "marking it repaired returns it to the banks a sync covers");
const retried = await syncAllItems(plaid);
eq(retried.itemsTotal, 1, "and the next sync tries it again");
eq((await listAllItems(db))[0]!.status, "login_required", "a repair that did not really take is marked again");
const rowsAfterExpiry = await db.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM transactions`);
eq(rowsAfterExpiry.rows[0]!.c, after.rows[0]!.c, "none of that touched the transactions already stored");

// persistence across a process-level close/reopen
await closeDb();
// The query string defeats the ESM module cache, forcing a genuinely fresh
// module instance — which is the point of the assertion below.
// The query string defeats the ESM module cache, forcing a genuinely fresh
// module instance — which is the point of the assertion below. TypeScript
// cannot resolve a specifier with a query string, so the type comes from the
// plain path and the specifier is built at runtime.
const REOPEN = "../src/domain/data/default-database.js?reopen=1";
const { db: db2, closeDb: close2 } = (await import(REOPEN)) as typeof import("../src/domain/data/default-database.js");
const persisted = await db2.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM transactions`);
eq(persisted.rows[0]!.c, after.rows[0]!.c, "data survives close/reopen");
await close2();

// --- unlinking, for real -----------------------------------------------------
// Last, because it destroys the Item everything above depended on. Every other
// suite hands the unlink a stand-in for Plaid; this is the one place it removes
// an Item from Plaid's own servers.
const unlinked = await unlinkBank(plaid, linkedItem.itemId, { revokeAtPlaid: true });
eq(
  unlinked.outcome === "unlinked" ? unlinked.revokedAtPlaid : unlinked.outcome,
  true,
  "unlinking with removal at Plaid: unlinked, and removed at Plaid",
);
const leftBehind = await db.query<{ items: string; transactions: string }>(
  `SELECT (SELECT COUNT(*) FROM items)::text AS items, (SELECT COUNT(*) FROM transactions)::text AS transactions`);
eq(leftBehind.rows[0], { items: "0", transactions: "0" }, "the bank and its transactions are gone from the database");
const stillAtPlaid = await plaid.api.itemGet({ access_token: linkedItem.accessToken! }).then(
  () => "Plaid still knows the Item",
  () => "Plaid no longer accepts its token",
);
eq(stillAtPlaid, "Plaid no longer accepts its token", "AND THE ITEM IS REALLY GONE AT PLAID");
await closeDb();

console.log(out.join("\n"));
console.log(fail === 0 ? `\nAll ${out.filter(l => l.startsWith("  ok") || l.startsWith("  FAIL")).length} checks passed.` : `\n${fail} FAILED.`);
await removeScratchProfile();
process.exit(fail === 0 ? 0 : 1);
