/**
 * `queryReadOnly()` — the guard that lets model-written SQL touch this database.
 *
 * Three assertions here matter more than the rest:
 *
 *   1. A data-modifying CTE is rejected. It begins with the word WITH, so every
 *      "must start with SELECT" filter waves it through. This is the single
 *      concrete reason the implementation refuses to inspect the SQL.
 *   2. `access_token_enc` cannot be read. Read-only stops writes, not reads;
 *      only the role stops this one.
 *   3. The role and the read-only flag do NOT survive the transaction. These
 *      connections are pooled, so a leak here would demote an unrelated sync
 *      hours later — the kind of bug that is nearly impossible to trace back.
 */

import { fileURLToPath } from "node:url";
import { readFile, rm } from "node:fs/promises";

const P = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");

// Its own profile, set before anything resolves one. Short path: the unix
// socket derives from it and sockaddr_un caps near 104 bytes.
const HOME = "/tmp/costingly-readonly";
process.env["COSTINGLY_HOME"] = HOME;

// SAFETY: everything below wipes HOME. Refuse to run if it is not the scratch
// path above — a stray COSTINGLY_HOME in the environment must not cost anyone
// their real database.
if (HOME !== "/tmp/costingly-readonly") throw new Error("refusing to run against a real profile");

const { query, closeDb, stopServer, setMigrationSource } = await import("../src/index.js");
const { queryReadOnly } = await import("../src/db/readonly.js");

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

/** Run something that must be refused, and hand back the refusal. */
async function rejected(sql: string): Promise<string> {
  try {
    await queryReadOnly(sql);
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
const blocked = async (sql: string, what: string): Promise<void> =>
  ok((await rejected(sql)) !== "", what);

async function wipe(): Promise<void> {
  await stopServer().catch(() => {});
  await rm(HOME, { recursive: true, force: true });
}
await wipe();

// Register the migration loader the way cli/index.ts does, then let the first
// query build the database. Tests take the same path a real install takes.
const { loadMigrations } = await import("../cli/migrations.js");
setMigrationSource(loadMigrations);

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
          '{"primary":"INCOME","detailed":"INCOME_WAGES"}'::jsonb, '{}'::jsonb)`);

// --- it works at all --------------------------------------------------------
const basic = await queryReadOnly("SELECT description, amount FROM v_transactions ORDER BY date");
eq(basic.rows.length, 2, "a plain SELECT returns its rows");
eq(basic.columns, ["description", "amount"], "column names come back in select order");
eq(basic.truncated, false, "a small result is not flagged as truncated");
eq(basic.rows[0]?.["description"], "COFFEE", "and the rows are the real ones");

const empty = await queryReadOnly("SELECT description, amount FROM v_transactions WHERE false");
eq(empty.rows.length, 0, "a query matching nothing returns no rows");
eq(empty.columns, ["description", "amount"], "COLUMNS ARE STILL KNOWN WHEN THERE ARE NO ROWS");

const withParams = await queryReadOnly(
  "SELECT description FROM v_transactions WHERE amount > $1", { params: [0] });
eq(withParams.rows.length, 1, "parameters survive the LIMIT wrapper");

eq((await queryReadOnly("SELECT 1 AS n;  ")).rows[0]?.["n"], 1,
   "a trailing semicolon is tolerated, the way a person would type it");

// --- writes: rejected by the read-only transaction --------------------------
await blocked("INSERT INTO transactions (transaction_id) VALUES ('x')", "INSERT is rejected");
await blocked("UPDATE items SET status = 'x'", "UPDATE is rejected");
await blocked("DELETE FROM transactions WHERE false", "DELETE is rejected");
await blocked("DROP TABLE transactions", "DROP is rejected");
await blocked("CREATE TABLE _x (a int)", "DDL is rejected");

// THE ONE THAT DEFEATS STRING INSPECTION. Starts with WITH, not SELECT.
await blocked(
  `WITH gone AS (DELETE FROM transactions WHERE false RETURNING *) SELECT count(*) FROM gone`,
  "A DATA-MODIFYING CTE IS REJECTED (it does not start with SELECT)");

// Interior semicolon: lands inside the subquery, where it cannot parse.
await blocked("SELECT 1; DROP TABLE items", "a second statement after `;` is rejected");

// --- reads: rejected by the role, not by read-only --------------------------
await blocked("SELECT * FROM items", "the items TABLE is unreachable");
await blocked("SELECT access_token_enc FROM items", "ACCESS TOKENS CANNOT BE READ");
await blocked("SELECT raw FROM transactions", "raw Plaid payloads cannot be read");
await blocked("SELECT * FROM pg_authid", "Postgres' own credential table is unreachable");
await blocked("SELECT pg_read_file('/etc/passwd')", "the filesystem is unreachable");

// Proof that it is the ROLE doing this and not the read-only flag: the same
// statement is a pure read, and it is still refused.
ok(/permission denied/i.test(await rejected("SELECT access_token_enc FROM items")),
   "and the refusal is a PERMISSION error, so it is the role that stopped it");

// --- the cap ----------------------------------------------------------------
const capped = await queryReadOnly("SELECT g FROM generate_series(1, 50) g", { rowCap: 10 });
eq(capped.rows.length, 10, "the cap limits what comes back");
eq(capped.truncated, true, "and says so");
eq(capped.rowCap, 10, "and reports the cap that applied");

const exact = await queryReadOnly("SELECT g FROM generate_series(1, 10) g", { rowCap: 10 });
eq(exact.rows.length, 10, "exactly-at-the-cap returns every row");
eq(exact.truncated, false,
   "AND IS NOT FLAGGED TRUNCATED — this is why we fetch cap+1");

// --- the timeout ------------------------------------------------------------
// A short explicit timeout, so this proves the guard fires without the suite
// having to sit for ten seconds to find out.
const started = process.hrtime.bigint();
let slow = "";
try {
  await queryReadOnly("SELECT pg_sleep(30)", { timeoutMs: 300 });
} catch (error) {
  slow = error instanceof Error ? error.message : String(error);
}
const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
ok(/statement timeout|canceling statement/i.test(slow),
   `a query past the timeout is CANCELLED, not left running (${slow.slice(0, 40)})`);
ok(elapsedMs < 5000, `and cancelled promptly — ${Math.round(elapsedMs)}ms, not 30s`);

const setting = await queryReadOnly("SELECT current_setting('statement_timeout') AS t");
eq(setting.rows[0]?.["t"], "10s", "the default timeout is 10s");

// --- THE LEAK TEST ----------------------------------------------------------
// The pool holds up to 10 connections and hands them out in no fixed order, so
// one check could miss a poisoned one. Run enough to cover the pool several
// times over.
let leaked = "";
for (let i = 0; i < 30; i++) {
  const who = await query<{ u: string }>("SELECT current_user AS u");
  if (who.rows[0]?.u === "costingly_ro") leaked = "role";
  const ro = await query<{ ro: string }>("SELECT current_setting('transaction_read_only') AS ro");
  if (ro.rows[0]?.ro === "on") leaked = leaked ? `${leaked}+read_only` : "read_only";
}
eq(leaked, "", "NEITHER THE ROLE NOR READ-ONLY LEAKS ONTO THE POOLED CONNECTION");

// The strongest form of the same claim: ordinary access still works afterwards.
const after = await query("SELECT access_token_enc FROM items");
eq(after.rows.length, 1, "and the application can still read what it owns");

const timeoutAfter = await query<{ t: string }>("SELECT current_setting('statement_timeout') AS t");
eq(timeoutAfter.rows[0]?.t, "0", "the statement timeout reverts too");

await closeDb();
await wipe();

console.log(out.join("\n"));
console.log(fail === 0 ? `\nAll ${out.length} checks passed.` : `\n${fail} FAILED.`);
process.exit(fail === 0 ? 0 : 1);
