/**
 * Unlinking a bank — the one operation every interface uses — against a real
 * database, with a stand-in for Plaid.
 *
 *   1. Removed at Plaid, then deleted here, with everything under it
 *   2. PLAID FAILS: NOTHING IS DELETED, and the reason comes back
 *   3. Without the Plaid step, Plaid is never contacted
 *   4. Sample data has nothing at Plaid to remove
 *   5. A bank that is not there, and a token that cannot be read
 *   6. Wiping everything keeps going past a failed revoke — a different rule
 *
 * The Plaid client is handed to the operation, so the test hands it one that
 * records what it was asked and fails on demand. Removing a real Item at
 * Plaid's sandbox is the last step of e2e.test.mts.
 *
 * Runs on every platform. The data is tests/transaction-fixture.mts.
 */

import { rm } from "node:fs/promises";

import { CARD, CHECKING, FACTS, MAPLE, OAK, SAVINGS, saveFixture } from "./transaction-fixture.mjs";

const HOME = "/tmp/costingly-unlink";
process.env["COSTINGLY_HOME"] = HOME;
delete process.env["PLAID_CLIENT_ID"];
delete process.env["PLAID_SECRET"];

const { db, closeDb, server, generateEncryptionKey, writeConfig } = await import("../src/index.js");
const { install } = await import("../src/domain/services/install.service.js");
const { saveItem } = await import("../src/domain/data/repositories/items.repository.js");
const { upsertMany: saveAccounts } = await import("../src/domain/data/repositories/accounts.repository.js");
const { upsertMany: saveTransactions } = await import("../src/domain/data/repositories/transactions.repository.js");
const { describeBank, unlinkBank } = await import("../src/domain/services/banks/unlink.service.js");
const { removeAllItems } = await import("../src/domain/services/banks/reset.service.js");
type PlaidClient = import("../src/domain/data/plaid.client.js").PlaidClient;

const out: string[] = [];
let fail = 0;
function eq(a: unknown, b: unknown, what: string): void {
  if (JSON.stringify(a) === JSON.stringify(b)) out.push(`  ok    ${what}`);
  else {
    fail++;
    out.push(`  FAIL  ${what}\n          expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

async function wipe(): Promise<void> {
  await closeDb().catch(() => {});
  await server.stop().catch(() => {});
  await rm(HOME, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}

/**
 * A Plaid that records the tokens it was asked to remove, and refuses when
 * told to. Only `api.itemRemove` exists: anything else the operation reached
 * for would be a bug, and would fail loudly here.
 */
function standInPlaid(behaviour: "removes" | "refuses" = "removes") {
  const removed: string[] = [];
  const plaid = {
    api: {
      itemRemove: async ({ access_token }: { access_token: string }) => {
        if (behaviour === "refuses") throw new Error("ITEM_ERROR/ITEM_NOT_FOUND: the Item could not be removed");
        removed.push(access_token);
        return { data: {} };
      },
    },
  } as unknown as PlaidClient;
  return { plaid, removed };
}

/** What the database holds for one bank: its row, its accounts, its transactions. */
async function held(itemId: string): Promise<{ bank: number; accounts: number; transactions: number }> {
  const { rows } = await db.query<{ bank: string; accounts: string; transactions: string }>(
    `SELECT (SELECT COUNT(*) FROM items        WHERE item_id = $1)::text AS bank,
            (SELECT COUNT(*) FROM accounts     WHERE item_id = $1)::text AS accounts,
            (SELECT COUNT(*) FROM transactions WHERE item_id = $1)::text AS transactions`,
    [itemId],
  );
  const row = rows[0];
  return { bank: Number(row?.bank), accounts: Number(row?.accounts), transactions: Number(row?.transactions) };
}

async function load(): Promise<void> {
  await db.query(`DELETE FROM items`);
  await saveFixture({
    saveItem: (params) => saveItem(db, params),
    saveAccounts: (rows) => saveAccounts(db, rows),
    saveTransactions: (rows) => saveTransactions(db, rows),
  });
}

const MAPLE_HOLDS = { bank: 1, accounts: 2, transactions: FACTS.checking + FACTS.card };
const OAK_HOLDS = { bank: 1, accounts: 1, transactions: FACTS.savings };
const NOTHING = { bank: 0, accounts: 0, transactions: 0 };

await wipe();
// An encryption key, so the fixture's access tokens can be stored and read back.
await writeConfig({ plaidClientId: "placeholder", plaidSecret: "placeholder", encryptionKey: generateEncryptionKey() });
await install();

// ===========================================================================
// What is about to go
// ===========================================================================

await load();
eq(
  await describeBank(MAPLE),
  { itemId: MAPLE, institutionName: "Maple Bank", atPlaid: true, accounts: 2, transactions: FACTS.checking + FACTS.card },
  "describeBank names a bank and counts what it holds, before anything is deleted",
);
eq(await describeBank("no-such-bank"), null, "and says so when there is no such bank");
void [CHECKING, CARD, SAVINGS];

// ===========================================================================
// 1. Removed at Plaid, then deleted here
// ===========================================================================

{
  const { plaid, removed } = standInPlaid();
  eq(
    await unlinkBank(plaid, MAPLE, { revokeAtPlaid: true }),
    { outcome: "unlinked", institutionName: "Maple Bank", revokedAtPlaid: true },
    "unlink with removal at Plaid: unlinked, and it says the bank was removed at Plaid",
  );
  eq(removed, ["access-fixture-maple"], "Plaid was asked to remove that bank's own token, decrypted, once");
  eq(await held(MAPLE), NOTHING, "THE BANK, ITS ACCOUNTS AND ITS TRANSACTIONS ARE GONE");
  eq(await held(OAK), OAK_HOLDS, "AND THE OTHER BANK IS UNTOUCHED");
}

// ===========================================================================
// 2. Plaid fails
// ===========================================================================

await load();
{
  const { plaid } = standInPlaid("refuses");
  const outcome = await unlinkBank(plaid, MAPLE, { revokeAtPlaid: true });
  eq(outcome.outcome, "plaid-failed", "when Plaid will not remove the bank, the unlink is plaid-failed");
  eq(
    outcome.outcome === "plaid-failed" ? [outcome.institutionName, outcome.reason] : null,
    ["Maple Bank", "ITEM_ERROR/ITEM_NOT_FOUND: the Item could not be removed"],
    "with the bank's name and Plaid's reason",
  );
  eq(await held(MAPLE), MAPLE_HOLDS, "AND NOTHING WAS DELETED — the token is still there to try again");

  // ...which is exactly what trying again needs.
  const { plaid: working, removed } = standInPlaid();
  eq((await unlinkBank(working, MAPLE, { revokeAtPlaid: true })).outcome, "unlinked", "trying again, once Plaid answers, unlinks it");
  eq(removed, ["access-fixture-maple"], "using the token that survived the failed attempt");
}

// ===========================================================================
// 3. Without the Plaid step
// ===========================================================================

await load();
{
  const { plaid, removed } = standInPlaid("refuses");
  eq(
    await unlinkBank(plaid, MAPLE, { revokeAtPlaid: false }),
    { outcome: "unlinked", institutionName: "Maple Bank", revokedAtPlaid: false },
    "unlink from this machine only: unlinked, and it says the bank was NOT removed at Plaid",
  );
  eq(removed, [], "PLAID WAS NEVER CONTACTED — so it works with no network, and with a Plaid that would refuse");
  eq(await held(MAPLE), NOTHING, "and the bank and its data are gone from here");
}

// ===========================================================================
// 4. Sample data
// ===========================================================================

await load();
await db.query(`UPDATE items SET source = 'seed', access_token_enc = NULL WHERE item_id = $1`, [OAK]);
{
  eq((await describeBank(OAK))?.atPlaid, false, "a sample-data bank is described as having nothing at Plaid");
  const { plaid, removed } = standInPlaid("refuses");
  eq(
    await unlinkBank(plaid, OAK, { revokeAtPlaid: true }),
    { outcome: "unlinked", institutionName: "Oak Credit Union", revokedAtPlaid: false },
    "sample data unlinks even when removal at Plaid is asked for: there is nothing there to remove",
  );
  eq(removed, [], "and Plaid was not contacted");
  eq(await held(OAK), NOTHING, "it is gone");
}

// ===========================================================================
// 5. Not there, and a token that cannot be read
// ===========================================================================

{
  const { plaid, removed } = standInPlaid();
  eq(await unlinkBank(plaid, "no-such-bank", { revokeAtPlaid: true }), { outcome: "not-found" }, "an id no bank has is not-found");
  eq(removed, [], "and nothing was asked of Plaid");
}

await load();
await db.query(`UPDATE items SET access_token_enc = 'not.valid.ciphertext' WHERE item_id = $1`, [MAPLE]);
{
  const { plaid, removed } = standInPlaid();
  const outcome = await unlinkBank(plaid, MAPLE, { revokeAtPlaid: true });
  eq(outcome.outcome, "plaid-failed", "A TOKEN THAT CANNOT BE READ is a failed removal at Plaid, not a crash");
  eq(removed, [], "Plaid was not asked, having nothing to be asked with");
  eq(await held(MAPLE), MAPLE_HOLDS, "and nothing was deleted");
  eq(
    (await unlinkBank(plaid, MAPLE, { revokeAtPlaid: false })).outcome,
    "unlinked",
    "but it can still be unlinked from this machine — an unreadable token must not make a bank permanent",
  );
}

// ===========================================================================
// 6. Wiping everything is a different rule
// ===========================================================================

await load();
{
  const { plaid } = standInPlaid("refuses");
  const outcomes = await removeAllItems(plaid, { revoke: true });
  eq(outcomes.length, 2, "a wipe covers every bank");
  eq(outcomes.map((bank) => bank.revoked), [false, false], "a revoke that fails is reported as not revoked");
  eq(outcomes.every((bank) => typeof bank.revokeError === "string" && bank.revokeError !== ""), true, "with the reason, for each");
  eq(
    [await held(MAPLE), await held(OAK)],
    [NOTHING, NOTHING],
    "AND EVERYTHING IS DELETED ANYWAY — a wipe does not stop for Plaid, because what follows it does not either",
  );
}

await load();
{
  const { plaid, removed } = standInPlaid();
  const outcomes = await removeAllItems(plaid, { revoke: true });
  eq(outcomes.map((bank) => bank.revoked), [true, true], "a wipe with a working Plaid revokes every bank");
  eq([...removed].sort(), ["access-fixture-maple", "access-fixture-oak"], "each with its own token");
  eq((await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM items`)).rows[0]?.n, "0", "and nothing is left");
}

await wipe();

console.log(out.join("\n"));
console.log(fail === 0 ? `\nAll ${out.length} checks passed.` : `\n${fail} FAILED.`);
process.exit(fail === 0 ? 0 : 1);
