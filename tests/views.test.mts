/**
 * The view layer, the read-only role, and the generated dictionary.
 *
 * Two assertions here matter more than the rest:
 *
 *   1. `costingly_ro` cannot reach the base tables. That is what makes
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

const { query, withTransaction, execScript, closeDb, stopServer } = await import("../src/index.js");
const { describeSchema, renderSchemaDoc } = await import("../src/dictionary.js");

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
  await stopServer().catch(() => {});
  await rm(HOME, { recursive: true, force: true });
}
await wipe();

await execScript(await readFile(`${P}/schema.sql`, "utf8"));

// Enough data that the live facts have something to report.
await query(`INSERT INTO items (item_id, institution_name, access_token_enc, status)
             VALUES ('i1', 'Test Bank', 'aXY=.dGFn.Y2lwaGVy', 'active')`);
await query(`INSERT INTO accounts (account_id, item_id, name, mask, type, subtype, currency, current_balance)
             VALUES ('a1', 'i1', 'Checking', '0000', 'depository', 'checking', 'USD', 100.0)`);
await query(`
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
  (await query<{ column_name: string }>(
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
const raw = await query<{ n: string; s: string }>(
  `SELECT COUNT(*)::text n, SUM(amount)::text s FROM transactions`);
const via = await query<{ n: string; s: string }>(
  `SELECT COUNT(*)::text n, SUM(amount)::text s FROM v_transactions`);
eq(via.rows[0], raw.rows[0], "the view neither drops rows nor alters amounts");

// --- THE SECURITY PROPERTY ------------------------------------------------
async function asReadOnly(sql: string): Promise<{ allowed: boolean; message: string }> {
  try {
    await withTransaction(async (c) => {
      await c.query("SET LOCAL TRANSACTION READ ONLY");
      await c.query("SET LOCAL ROLE costingly_ro");
      await c.query(sql);
    });
    return { allowed: true, message: "" };
  } catch (error) {
    return { allowed: false, message: error instanceof Error ? error.message : String(error) };
  }
}

ok((await asReadOnly("SELECT 1 FROM v_transactions LIMIT 1")).allowed, "costingly_ro CAN read the views");
ok(!(await asReadOnly("SELECT 1 FROM items LIMIT 1")).allowed,
   "costingly_ro CANNOT reach the items table");
ok(!(await asReadOnly("SELECT access_token_enc FROM items LIMIT 1")).allowed,
   "costingly_ro CANNOT READ ACCESS TOKENS");
ok(!(await asReadOnly("SELECT raw FROM transactions LIMIT 1")).allowed,
   "costingly_ro cannot reach the raw payloads");
ok(!(await asReadOnly("UPDATE v_items SET status='x'")).allowed, "costingly_ro cannot write through a view");
ok(!(await asReadOnly("DELETE FROM transactions WHERE false")).allowed, "costingly_ro cannot delete");
ok(!(await asReadOnly("CREATE TABLE _x (a int)")).allowed, "costingly_ro cannot create objects");
ok(!(await asReadOnly("SELECT 1 FROM pg_authid LIMIT 1")).allowed,
   "costingly_ro cannot read Postgres' own credential table");

// --- comments: the thing that rots silently -------------------------------
// Self-evident columns that need no prose. Anything else must be commented, so
// adding a column forces a decision rather than quietly degrading the dictionary.
const NO_COMMENT_NEEDED = new Set([
  "transaction_id", "account_id", "item_id", "institution_id",
  "payment_channel", "official_name", "currency", "created_at",
]);

const doc = await describeSchema();
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

// --- live facts must reflect the data, not the schema ---------------------
eq(doc.facts.dateRange, { first: "2026-01-15", last: "2026-02-02" }, "date range comes from the data");
eq(doc.facts.categories, ["FOOD_AND_DRINK", "INCOME"],
   "only categories PRESENT in this database are listed, not Plaid's full set");
eq(doc.facts.currencies, ["USD"], "currencies come from the data");
eq(doc.facts.pendingCount, 1, "pending count is live");
eq(doc.facts.accounts.length, 1, "accounts are listed by name for filtering");
eq(doc.facts.accounts[0]?.institution, "Test Bank", "with their institution");
eq(doc.views.find((v) => v.name === "v_transactions")?.rowCount, 3, "row counts are live");

// --- the rendered document -------------------------------------------------
const text = renderSchemaDoc(doc);
ok(text.includes("POSITIVE = money OUT"), "the rendered doc carries the sign convention");
ok(text.includes("FOOD_AND_DRINK"), "the rendered doc lists real categories");
ok(text.includes("Test Bank"), "the rendered doc names real accounts");
ok(!text.includes("access_token_enc"), "THE RENDERED DOC NEVER MENTIONS THE TOKEN COLUMN");
ok(!text.includes("aXY=.dGFn"), "and never leaks a token value");
ok(text.length < 20000, `the doc is small enough to hand to a model (${text.length} chars)`);

// --- re-running the schema must not break the views -----------------------
await execScript(await readFile(`${P}/schema.sql`, "utf8"));
const again = await query<{ n: string }>(`SELECT COUNT(*)::text n FROM v_transactions`);
eq(again.rows[0]?.n, "3", "schema.sql is idempotent — views survive a re-run");
ok((await asReadOnly("SELECT 1 FROM v_items LIMIT 1")).allowed,
   "and the role's grants survive it too");

await closeDb();
await wipe();

console.log(out.join("\n"));
console.log(fail === 0 ? `\nAll ${out.length} checks passed.` : `\n${fail} FAILED.`);
process.exit(fail === 0 ? 0 : 1);
