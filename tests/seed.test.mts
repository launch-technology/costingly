/**
 * The seed generator, the `source` column, and the guard that keeps invented
 * money away from real money.
 *
 * Three groups of assertion, in order of how much damage the failure does:
 *
 *   1. THE GUARD. Seeding a profile that holds real bank data would mix
 *      fabricated transactions into someone's finances with no way to separate
 *      them afterwards. If only one thing here works, it should be this.
 *   2. THE CONSTRAINTS. `access_token_enc` is nullable now. That is only safe
 *      because the database still refuses a Plaid item without a token, so the
 *      constraint is tested directly rather than trusted.
 *   3. THE DATA. Determinism, sign conventions and the shape a demo depends on.
 */

import { rm } from "node:fs/promises";

// Its own profile, set before anything resolves one. Short path: the unix
// socket derives from it and sockaddr_un caps near 104 bytes.
const HOME = "/tmp/costingly-seed";
process.env["COSTINGLY_HOME"] = HOME;

const { db, closeDb, server } = await import("../src/index.js");
const { install } = await import("../src/domain/services/install.service.js");
const { generateSeedDataset } = await import("../src/domain/services/seed/seed.generator.js");
const { applySeed, assertSeedable, SeedRefused } = await import("../src/domain/services/seed/seed.service.js");
const { listSyncableItems, listAllItems, saveItem } = await import("../src/domain/data/repositories/items.repository.js");
const { createRepairLinkToken } = await import("../src/domain/services/banks/relink.service.js");

const out: string[] = [];
let fail = 0;
function eq(a: unknown, b: unknown, what: string): void {
  if (JSON.stringify(a) === JSON.stringify(b)) out.push(`  ok    ${what}`);
  else {
    fail++;
    out.push(`  FAIL  ${what}\n          expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}
const ok = (c: boolean, what: string): void => eq(c, true, what);

/** Assert that `run` rejects, and hand the error back for inspection. */
async function throws(run: () => Promise<unknown>, what: string): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    out.push(`  ok    ${what}`);
    return error;
  }
  fail++;
  out.push(`  FAIL  ${what}\n          expected a throw, got none`);
  return undefined;
}

async function wipe(): Promise<void> {
  await server.stop().catch(() => {});
  // maxRetries: Windows can still hold handles on the cluster directory for a
  // moment after the postmaster exits, which unlink-while-open unix does not.
  await rm(HOME, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
await wipe();

// Explicit, because reading no longer creates. A suite that needs a database
// now has to say so — which is the point of the change it is testing under.
await install();

const { loadMigrations } = await import("../src/platform/postgres/migrations.js");

// ===========================================================================
// The generator, before any database is involved
// ===========================================================================

const FIXED = { endDate: "2026-08-09", years: 2 } as const;
const first = generateSeedDataset(FIXED);
const second = generateSeedDataset(FIXED);

eq(JSON.stringify(first), JSON.stringify(second),
   "SAME OPTIONS PRODUCE IDENTICAL DATA — a demo can be re-recorded");
ok(JSON.stringify(generateSeedDataset({ ...FIXED, seed: 7 })) !== JSON.stringify(first),
   "a different seed produces different data");
ok(JSON.stringify(generateSeedDataset({ ...FIXED, endDate: "2026-08-08" })) !== JSON.stringify(first),
   "a different end date produces different data");

ok(first.transactions.length > 1200, `two years is a usable volume (${first.transactions.length})`);
eq(first.transactions.filter((t) => t.date > FIXED.endDate).length, 0,
   "nothing is dated after the requested end date");
eq(first.transactions.filter((t) => t.date < "2024-08-09").length, 0,
   "nothing is dated before the requested window");
eq(first.transactions.length - new Set(first.transactions.map((t) => t.transactionId)).size, 0,
   "transaction ids are unique");
eq(first.transactions.filter((t) => !Number.isFinite(t.amount) || t.amount === 0).length, 0,
   "every amount is a non-zero finite number");
eq(first.transactions.filter((t) => Math.abs(Math.round(t.amount * 100) - t.amount * 100) > 1e-9).length, 0,
   "amounts stay within NUMERIC(20,4)");
eq(first.transactions.filter((t) => !first.accounts.some((a) => a.accountId === t.accountId)).length, 0,
   "every transaction belongs to a generated account");

// Positive is money out. Income must therefore be negative, or every spending
// query in a demo reads backwards.
const income = first.transactions.filter((t) => t.pfcPrimary === "INCOME");
ok(income.length > 40, `income transactions exist (${income.length})`);
eq(income.filter((t) => t.amount >= 0).length, 0, "income is NEGATIVE — money in, per the schema convention");
ok(first.transactions.some((t) => t.amount > 0), "spending is POSITIVE — money out");

// Both halves of every transfer, so a naive SUM visibly nets out rather than
// quietly counting one side.
const transferTotal = first.transactions
  .filter((t) => t.pfcPrimary.startsWith("TRANSFER"))
  .reduce((sum, t) => sum + t.amount, 0);
ok(Math.abs(transferTotal) < 0.005, `transfers net to zero (${transferTotal.toFixed(2)})`);

// Descriptions are the thing that makes this look like a bank feed rather than
// a fixture. Both kinds must be present.
const unresolved = first.transactions.filter((t) => t.merchantName === null).length;
const share = unresolved / first.transactions.length;
ok(share > 0.2 && share < 0.8, `merchant_name is realistically patchy (${Math.round(share * 100)}% null)`);
ok(first.transactions.some((t) => /^TST\*/.test(t.name)), "raw terminal-style descriptions are present");
ok(first.transactions.some((t) => t.name === "Netflix"), "clean merchant descriptions are present");

// Real institution names in a screenshot imply a relationship costingly does
// not have.
const REAL_BANKS = ["chase", "bank of america", "wells fargo", "citi", "amex", "american express"];
eq(first.items.filter((i) => REAL_BANKS.some((b) => i.institutionName.toLowerCase().includes(b))).length, 0,
   "no real bank names appear in the generated data");

// ===========================================================================
// The database
// ===========================================================================

const summary = await applySeed(first);
eq(summary.transactions, first.transactions.length, "every generated transaction was stored");
eq(summary.accounts, first.accounts.length, "every generated account was stored");

const stored = await db.query<{ c: string }>(`SELECT COUNT(*)::text c FROM transactions`);
eq(stored.rows[0]!.c, String(first.transactions.length), "the row count in the database matches");

// --- what the model can see ------------------------------------------------
const view = await db.query<{ source: string }>(`SELECT DISTINCT source FROM v_items`);
eq(view.rows.map((r) => r.source), ["seed"], "v_items reports these banks as source 'seed'");

const comment = await db.query<{ d: string | null }>(
  `SELECT col_description('v_items'::regclass, ordinal_position) AS d
     FROM information_schema.columns
    WHERE table_name = 'v_items' AND column_name = 'source'`,
);
ok((comment.rows[0]?.d ?? "").length > 40,
   "v_items.source carries a comment — the model's only warning that this is not real money");

// --- seeded items are inert ------------------------------------------------
eq(await listSyncableItems(db), [], "SEEDED BANKS ARE NEVER SYNCED");

const all = await listAllItems(db);
eq(all.length, first.items.length, "seeded banks are still listed for maintenance");
eq(all.filter((i) => i.accessToken !== null).length, 0, "no seeded bank carries an access token");
eq(all.filter((i) => i.source !== "seed").length, 0, "every stored item reports source 'seed'");

const repairError = await throws(
  () => createRepairLinkToken(first.items[0]!.itemId),
  "relinking a seeded bank is refused",
);
ok(String((repairError as Error).message).includes("sample data"),
   "...and the refusal says why, rather than surfacing a Plaid error");

// --- re-seeding replaces rather than accumulates ---------------------------
await applySeed(generateSeedDataset(FIXED));
const afterRerun = await db.query<{ c: string }>(`SELECT COUNT(*)::text c FROM transactions`);
eq(afterRerun.rows[0]!.c, String(first.transactions.length), "re-seeding replaces, it does not accumulate");

// ===========================================================================
// The constraints that make a nullable token safe
// ===========================================================================

const nullToken = await throws(
  () => db.query(`INSERT INTO items (item_id, access_token_enc, source) VALUES ('bad', NULL, 'plaid')`),
  "the database REFUSES a plaid item with no access token",
);
ok(String((nullToken as Error).message).includes("items_plaid_needs_token"),
   "...by the named constraint, not by accident");

await throws(
  () => db.query(`INSERT INTO items (item_id, access_token_enc, source) VALUES ('bad', 'x.y.z', 'imported')`),
  "the database refuses an unknown source value",
);

// ===========================================================================
// The guard
// ===========================================================================

await saveItem(db, {
  itemId: "real-bank",
  institutionId: "ins_1",
  institutionName: "A Real Bank",
  accessToken: "access-sandbox-not-real",
  source: "plaid",
});

const refusal = await throws(() => assertSeedable(), "SEEDING A PROFILE WITH REAL BANKS IS REFUSED");
ok(refusal instanceof SeedRefused, "...with a typed error the CLI can present cleanly");
ok(String((refusal as Error).message).includes("COSTINGLY_HOME"),
   "...and the message names the way out");

const before = await db.query<{ c: string }>(`SELECT COUNT(*)::text c FROM transactions`);
await throws(() => applySeed(generateSeedDataset(FIXED)), "applySeed refuses too, not just the CLI");
const after = await db.query<{ c: string }>(`SELECT COUNT(*)::text c FROM transactions`);
eq(after.rows[0]!.c, before.rows[0]!.c, "THE REFUSED SEED CHANGED NOTHING — it fails before deleting");

await closeDb();
await wipe();

console.log(out.join("\n"));
console.log(fail === 0 ? `\nAll ${out.length} checks passed.` : `\n${fail} FAILED.`);
process.exit(fail === 0 ? 0 : 1);
