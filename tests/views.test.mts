/**
 * The view layer, the read-only role, and the generated dictionary.
 *
 * Two assertions here matter more than the rest:
 *
 *   1. `role_readonly` cannot reach the base tables. That is what makes
 *      `access_token_enc` genuinely unreachable rather than merely absent from
 *      a view definition.
 *   2. Every view column carries a comment, or is on an explicit list of
 *      self-evident ones. Comments are the only thing telling a reader that
 *      positive amounts mean spending; a column added without one degrades the
 *      dictionary silently, and nothing else would catch it.
 */

import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Repo root, derived from this file — no absolute paths baked in. */
const P = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

// Its own profile, set before anything resolves one. Short path: the unix
// socket derives from it and sockaddr_un caps near 104 bytes.
const HOME = "/tmp/costingly-views";
process.env["COSTINGLY_HOME"] = HOME;

const { db, closeDb, server } = await import("../src/index.js");
const { install } = await import("../src/domain/services/install.service.js");
const { describeDatabase } = await import("../src/domain/data/repositories/schema.repository.js");
const { renderDatabaseDoc } = await import("../src/apps/mcp/tools/describe-database.utils.js");

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

// Register the migration loader the way cli/main.ts does, then let the first
// query build the database. Tests take the same path a real install takes.
const { loadMigrations } = await import("../src/platform/postgres/migrations.js");

// Enough data that the live facts have something to report.
await db.query(`INSERT INTO items (item_id, institution_name, access_token_enc, status)
             VALUES ('i1', 'Test Bank', 'aXY=.dGFn.Y2lwaGVy', 'active')`);
await db.query(`INSERT INTO accounts (account_id, item_id, name, mask, type, subtype, currency, current_balance)
             VALUES ('a1', 'i1', 'Checking', '0000', 'depository', 'checking', 'USD', 100.0)`);
await db.query(`
  INSERT INTO transactions (transaction_id, account_id, item_id, amount, iso_currency_code,
                            date, name, merchant_name, pending, pfc, raw)
  VALUES ('t1','a1','i1',  42.10,'USD','2026-01-15','COFFEE','Blue Bottle', false,
          '{"primary":"FOOD_AND_DRINK","detailed":"FOOD_AND_DRINK_COFFEE"}'::jsonb, '{}'::jsonb),
         ('t2','a1','i1',-500.00,'USD','2026-02-01','PAYROLL','Employer',    false,
          '{"primary":"INCOME","detailed":"INCOME_WAGES"}'::jsonb, '{}'::jsonb),
         ('t3','a1','i1',  10.00,'USD','2026-02-02','PENDING THING',NULL,    true,
          NULL, '{}'::jsonb)`);

// --- the views exist and hide what they must ------------------------------
const cols = async (rel: string): Promise<string[]> =>
  (await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position`, [rel],
  )).rows.map((r) => r.column_name);

const itemCols = await cols("v_items");
const txnCols = await cols("v_transactions");

ok(itemCols.length > 0, "v_items exists");
ok(!itemCols.includes("access_token_enc"), "v_items does NOT expose access_token_enc");
ok(!itemCols.includes("cursor"), "v_items does not expose the opaque sync cursor");
ok(!txnCols.includes("raw"), "v_transactions does NOT expose the raw Plaid payload");
ok(txnCols.includes("category"), "v_transactions flattens pfc into `category`");
ok(txnCols.includes("account_name") && txnCols.includes("institution_name"),
   "v_transactions joins the names a practical query needs");

// The view must not silently change the numbers.
const raw = await db.query<{ n: string; s: string }>(
  `SELECT COUNT(*)::text n, SUM(amount)::text s FROM transactions`);
const via = await db.query<{ n: string; s: string }>(
  `SELECT COUNT(*)::text n, SUM(amount)::text s FROM v_transactions`);
eq(via.rows[0], raw.rows[0], "the view neither drops rows nor alters amounts");

// --- THE SECURITY PROPERTY ------------------------------------------------
async function asReadOnly(sql: string): Promise<{ allowed: boolean; message: string }> {
  try {
    await db.transaction(async (c) => {
      await c.query("SET LOCAL TRANSACTION READ ONLY");
      await c.query("SET LOCAL ROLE role_readonly");
      await c.query(sql);
    });
    return { allowed: true, message: "" };
  } catch (error) {
    return { allowed: false, message: error instanceof Error ? error.message : String(error) };
  }
}

ok((await asReadOnly("SELECT 1 FROM v_transactions LIMIT 1")).allowed, "role_readonly CAN read the views");
ok(!(await asReadOnly("SELECT 1 FROM items LIMIT 1")).allowed,
   "role_readonly CANNOT reach the items table");
ok(!(await asReadOnly("SELECT access_token_enc FROM items LIMIT 1")).allowed,
   "role_readonly CANNOT READ ACCESS TOKENS");
ok(!(await asReadOnly("SELECT raw FROM transactions LIMIT 1")).allowed,
   "role_readonly cannot reach the raw payloads");
ok(!(await asReadOnly("UPDATE v_items SET status='x'")).allowed, "role_readonly cannot write through a view");
ok(!(await asReadOnly("DELETE FROM transactions WHERE false")).allowed, "role_readonly cannot delete");
ok(!(await asReadOnly("CREATE TABLE _x (a int)")).allowed, "role_readonly cannot create objects");
ok(!(await asReadOnly("SELECT 1 FROM pg_authid LIMIT 1")).allowed,
   "role_readonly cannot read Postgres' own credential table");

// --- comments: the thing that rots silently -------------------------------
// Self-evident columns that need no prose. Anything else must be commented, so
// adding a column forces a decision rather than quietly degrading the dictionary.
const NO_COMMENT_NEEDED = new Set([
  "transaction_id", "account_id", "item_id", "institution_id",
  "official_name", "currency", "created_at",
]);

const doc = await describeDatabase(db);
const uncommented = doc.views.flatMap((v) =>
  v.columns.filter((c) => c.comment === null && !NO_COMMENT_NEEDED.has(c.name))
    .map((c) => `${v.name}.${c.name}`));
eq(uncommented, [], "EVERY non-obvious view column carries a COMMENT ON");
ok(doc.views.every((v) => v.comment !== null), "every view itself is commented");

// The single most important comment in the database.
const amount = doc.views.find((v) => v.name === "v_transactions")
  ?.columns.find((c) => c.name === "amount");
ok(/POSITIVE = money OUT/.test(amount?.comment ?? ""),
   "THE SIGN CONVENTION IS DOCUMENTED ON amount");
const pending = doc.views.find((v) => v.name === "v_transactions")
  ?.columns.find((c) => c.name === "pending");
ok(/double-count/.test(pending?.comment ?? ""), "the pending double-count trap is documented");

// The comments now carry the burden the old live-facts section carried: telling
// a reader that a literal must be looked up rather than guessed.
const category = doc.views.find((v) => v.name === "v_transactions")
  ?.columns.find((c) => c.name === "category");
ok(/ENUMERATE BEFORE FILTERING/.test(category?.comment ?? ""),
   "category tells the reader to enumerate rather than guess a value");

// --- the rendered document -------------------------------------------------
const text = renderDatabaseDoc(doc);
ok(text.includes("POSITIVE = money OUT"), "the rendered doc carries the sign convention");
ok(text.includes("SELECT DISTINCT"), "and shows how to enumerate values");
ok(!text.includes("access_token_enc"), "THE RENDERED DOC NEVER MENTIONS THE TOKEN COLUMN");
ok(!text.includes("aXY=.dGFn"), "and never leaks a token value");
ok(text.length < 20000, `the doc is small enough to hand to a model (${text.length} chars)`);

// --- it describes structure, never contents -------------------------------
// These strings exist only in the rows inserted above. If any appears, some
// data-derived fact has crept back into the document.
ok(!text.includes("Test Bank"), "THE DOC NAMES NO INSTITUTION FROM THE DATA");
ok(!text.includes("Blue Bottle"), "no merchant names from the data");
ok(!text.includes("Checking"), "no account names from the data");
ok(!/\d[\d,]*\s+rows/.test(text), "no row counts");

// --- re-running the schema must not break the views -----------------------

const again = await db.query<{ n: string }>(`SELECT COUNT(*)::text n FROM v_transactions`);
eq(again.rows[0]?.n, "3", "schema.sql is idempotent — views survive a re-run");
ok((await asReadOnly("SELECT 1 FROM v_items LIMIT 1")).allowed,
   "and the role's grants survive it too");

// --- THE CACHING INVARIANT --------------------------------------------------
// The document is computed once per process and reused for its lifetime. That
// is only sound if new data cannot change it. Add a transaction and a whole
// account, then re-render: any row count, date range or value enumeration that
// creeps back in makes these bytes differ, and the cache would start lying.
await db.query(`INSERT INTO accounts (account_id, item_id, name, mask, type, subtype, currency, current_balance)
             VALUES ('a2', 'i1', 'Savings', '1111', 'depository', 'savings', 'EUR', 900.0)`);
await db.query(`
  INSERT INTO transactions (transaction_id, account_id, item_id, amount, iso_currency_code,
                            date, name, merchant_name, pending, pfc, raw)
  VALUES ('t4','a2','i1', 7.77,'EUR','2027-06-01','LATER THING','Someone', false,
          '{"primary":"GENERAL_MERCHANDISE","detailed":"GENERAL_MERCHANDISE_OTHER"}'::jsonb, '{}'::jsonb)`);

eq(renderDatabaseDoc(await describeDatabase(db)), text,
   "THE DOCUMENT IS BYTE-IDENTICAL AFTER NEW DATA — this is what makes it cacheable");

await closeDb();
await wipe();

console.log(out.join("\n"));
console.log(fail === 0 ? `\nAll ${out.length} checks passed.` : `\n${fail} FAILED.`);
process.exit(fail === 0 ? 0 : 1);
