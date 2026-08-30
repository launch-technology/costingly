/**
 * `costingly status` — what is linked and how fresh it is.
 *
 *   costingly status          human-readable summary
 *   costingly status --json   machine-readable, for monitoring
 *
 * Read-only, and deliberately never decrypts an access token — answering
 * "what do I have connected?" should not require touching the credentials.
 */

import type { Command } from "commander";
import { query } from "../../data/db/queries.js";
import { describeServer } from "../../data/db/server.js";
import { money, ago } from "./format.js";

type Row = {
  item_id: string;
  institution_name: string | null;
  status: string;
  last_synced_at: Date | null;
  never_synced: boolean;
  source: string;
  account_id: string | null;
  account_name: string | null;
  mask: string | null;
  type: string | null;
  subtype: string | null;
  currency: string | null;
  current_balance: string | null;
  txn_count: string;
  first_date: string | null;
  last_date: string | null;
};

/**
 * Flag the states that need the user to do something.
 *
 * Seeded banks are checked first and always return early. They have no cursor,
 * so every other branch here would tell the user to run a sync that will never
 * touch them — the one instruction guaranteed to be wrong.
 */
function statusNote(status: string, neverSynced: boolean, source: string): string {
  if (source === "seed") return "  ·  sample data — not a real bank, never synced";
  if (status === "login_required") return "  ⚠  NEEDS RE-LINK — run `costingly link`";
  if (status !== "active") return `  ⚠  status: ${status}`;
  if (neverSynced) return "  ·  never synced — run `costingly sync` for the backfill";
  return "";
}

/**
 * Machine-readable form, for scripts and monitoring.
 *
 * `needsAttention` is the field worth alerting on: true when a bank has fallen
 * out of 'active' or has never completed a sync.
 */
function emitJson(byItem: Map<string, Row[]>): void {
  const items = [...byItem.values()].map((itemRows) => {
    const head = itemRows[0]!;
    const accounts = itemRows.filter((row) => row.account_id !== null);
    return {
      itemId: head.item_id,
      institutionName: head.institution_name,
      status: head.status,
      neverSynced: head.never_synced,
      source: head.source,
      lastSyncedAt: head.last_synced_at?.toISOString() ?? null,
      // Seeded banks are never actionable: there is nothing to re-link and
      // nothing to sync, so alerting on them would be permanent noise.
      needsAttention:
        head.source !== "seed" && (head.status !== "active" || head.never_synced),
      accounts: accounts.map((row) => ({
        accountId: row.account_id,
        name: row.account_name,
        mask: row.mask,
        type: row.type,
        subtype: row.subtype,
        currency: row.currency,
        // Kept as strings: these are NUMERIC, and parsing to a JS float would
        // reintroduce the rounding NUMERIC exists to avoid.
        currentBalance: row.current_balance,
        transactionCount: Number(row.txn_count),
        firstDate: row.first_date,
        lastDate: row.last_date,
      })),
    };
  });

  console.log(
    JSON.stringify(
      {
        items,
        accounts: items.reduce((total, item) => total + item.accounts.length, 0),
        transactions: items.reduce(
          (total, item) =>
            total + item.accounts.reduce((sum, account) => sum + account.transactionCount, 0),
          0,
        ),
        needsAttention: items.some((item) => item.needsAttention),
      },
      null,
      2,
    ),
  );
}

interface StatusOptions {
  json?: boolean;
}

export function registerStatusCommand(program: Command): void {
  program
    .command("status")
    .description("What's linked, balances, how fresh it is")
    .helpGroup("Looking at your data:")
    .option("--json", "emit JSON instead of a human-readable summary")
    .addHelpText(
      "after",
      `
Never decrypts an access token — this only reads metadata.

  costingly status --json | jq '.needsAttention'`,
    )
    .action(async (options: StatusOptions) => {
      await runStatus(options);
    });
}

/**
 * Where the data actually lives.
 *
 * Worth printing every time: the server is a process that can be up or down,
 * and "is it running?" is the first question when something behaves oddly.
 */
async function databaseLine(): Promise<string> {
  return describeServer();
}

export async function runStatus(options: StatusOptions): Promise<void> {
  const { rows } = await query<Row>(`
    SELECT i.item_id,
           i.institution_name,
           i.status,
           i.last_synced_at,
           i.cursor IS NULL           AS never_synced,
           i.source,
           a.account_id,
           a.name                     AS account_name,
           a.mask,
           a.type,
           a.subtype,
           a.currency,
           a.current_balance,
           COALESCE(t.txn_count, 0)::text AS txn_count,
           t.first_date::text         AS first_date,
           t.last_date::text          AS last_date
      FROM items i
      LEFT JOIN accounts a ON a.item_id = i.item_id
      LEFT JOIN LATERAL (
             SELECT COUNT(*) AS txn_count, MIN(date) AS first_date, MAX(date) AS last_date
               FROM transactions
              WHERE account_id = a.account_id
           ) t ON TRUE
     ORDER BY i.institution_name NULLS LAST, a.name NULLS LAST
  `);

  if (rows.length === 0) {
    if (options.json) {
      console.log(
        JSON.stringify(
          { items: [], accounts: 0, transactions: 0, needsAttention: false },
          null,
          2,
        ),
      );
      return;
    }
    console.log(`\n${await databaseLine()}`);
    console.log("\nNo banks linked yet. Run `costingly link` to connect one.");
    return;
  }

  // Group the flat join back into one block per bank.
  const byItem = new Map<string, Row[]>();
  for (const row of rows) {
    const existing = byItem.get(row.item_id);
    if (existing) existing.push(row);
    else byItem.set(row.item_id, [row]);
  }

  if (options.json) {
    emitJson(byItem);
    return;
  }

  let totalAccounts = 0;
  let totalTxns = 0;

  console.log("");
  for (const itemRows of byItem.values()) {
    const head = itemRows[0]!;
    const name = head.institution_name ?? "(unknown institution)";

    console.log(`${name}${statusNote(head.status, head.never_synced, head.source)}`);
    console.log(`  item ${head.item_id}  ·  last synced: ${ago(head.last_synced_at)}`);

    for (const row of itemRows) {
      if (row.account_id === null) {
        console.log("    (no accounts stored — run `costingly sync`)");
        continue;
      }
      totalAccounts += 1;
      const count = Number(row.txn_count);
      totalTxns += count;

      const label = `${row.account_name ?? "(unnamed)"} ••${row.mask ?? "????"}`;
      const kind = `${row.type ?? "?"}/${row.subtype ?? "?"}`;
      const span =
        count > 0 && row.first_date && row.last_date
          ? `${row.first_date} → ${row.last_date}`
          : "no transactions";

      console.log(
        `    ${label.padEnd(30)} ${kind.padEnd(22)} ` +
          `${money(row.current_balance, row.currency).padStart(14)}  ` +
          `${String(count).padStart(5)} txns  ${span}`,
      );
    }
    console.log("");
  }

  console.log(
    `${byItem.size} bank(s), ${totalAccounts} account(s), ${totalTxns} transaction(s)`,
  );
  console.log(await databaseLine());
}
