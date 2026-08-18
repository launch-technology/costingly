/**
 * Writing a generated dataset into the database.
 *
 * Split from generate.ts so the generator stays pure and testable: it produces
 * plain objects and touches nothing.
 *
 * THE GUARD IS THE IMPORTANT PART
 *
 * Seeding a profile that holds real bank data would mix invented money into
 * someone's actual finances, and no later query could tell the two apart in a
 * report. So this refuses outright when any Plaid Item is present. There is no
 * --force: the correct move is a different profile, which costs nothing.
 */

import { withTransaction, query, type DbClient } from "../db/client.js";
import { saveItem } from "../plaid/items.js";
import type { SeedDataset, SeedTransaction } from "./generate.js";

export class SeedRefused extends Error {}

/**
 * Reject profiles that contain real bank data.
 *
 * Checked against `source`, not against row counts — a profile holding only
 * previously seeded data is fine to re-seed, and that is the common case while
 * iterating on the generator.
 */
export async function assertSeedable(): Promise<void> {
  const { rows } = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM items WHERE source = 'plaid'`,
  );
  const linked = Number(rows[0]?.count ?? 0);
  if (linked > 0) {
    throw new SeedRefused(
      `This profile has ${linked} real bank connection(s) in it.\n\n` +
        `Seeding here would mix invented transactions into your actual financial\n` +
        `data, and nothing downstream could reliably tell them apart again.\n\n` +
        `Point COSTINGLY_HOME at a different directory and seed that instead:\n\n` +
        `  COSTINGLY_HOME=~/costingly-demo costingly seed\n`,
    );
  }
}

/**
 * Plaid's transaction object, reconstructed for the `raw` column.
 *
 * `transactions.raw` is NOT NULL and holds the provider's payload verbatim, so
 * that a new column can be backfilled from it without re-syncing. Seeded rows
 * have no provider, so the payload is rebuilt from the row itself — which keeps
 * that promise true for anything reading `raw` without caring where the row
 * came from.
 */
function rawPayload(txn: SeedTransaction): Record<string, unknown> {
  return {
    transaction_id: txn.transactionId,
    account_id: txn.accountId,
    amount: txn.amount,
    iso_currency_code: txn.isoCurrencyCode,
    unofficial_currency_code: null,
    date: txn.date,
    authorized_date: txn.authorizedDate,
    name: txn.name,
    merchant_name: txn.merchantName,
    pending: txn.pending,
    pending_transaction_id: null,
    payment_channel: txn.paymentChannel,
    personal_finance_category: {
      primary: txn.pfcPrimary,
      detailed: txn.pfcDetailed,
      confidence_level: "VERY_HIGH",
    },
    // Says so in the payload as well as the column, for anyone who reaches for
    // `raw` and skips v_items.
    costingly_source: "seed",
  };
}

export interface SeedSummary {
  items: number;
  accounts: number;
  transactions: number;
  firstDate: string | null;
  lastDate: string | null;
}

/**
 * Replace any existing seeded data with `dataset`.
 *
 * Re-seeding deletes the previous seed first (cascading to its accounts and
 * transactions) so running this twice is not additive. Real Items are never in
 * scope — assertSeedable() has already established there are none.
 */
export async function applySeed(dataset: SeedDataset): Promise<SeedSummary> {
  await assertSeedable();

  await query(`DELETE FROM items WHERE source = 'seed'`);

  for (const item of dataset.items) {
    await saveItem({
      itemId: item.itemId,
      institutionId: item.institutionId,
      institutionName: item.institutionName,
      accessToken: null,
      source: "seed",
    });
  }

  await withTransaction(async (client) => {
    for (const account of dataset.accounts) {
      await client.query(
        `INSERT INTO accounts (
           account_id, item_id, name, official_name, mask, type, subtype,
           currency, current_balance, available_balance, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())`,
        [
          account.accountId,
          account.itemId,
          account.name,
          account.officialName,
          account.mask,
          account.type,
          account.subtype,
          account.currency,
          account.currentBalance,
          account.availableBalance,
        ],
      );
    }
    await insertTransactions(client, dataset.transactions);
  });

  const dates = dataset.transactions.map((t) => t.date).sort();
  return {
    items: dataset.items.length,
    accounts: dataset.accounts.length,
    transactions: dataset.transactions.length,
    firstDate: dates[0] ?? null,
    lastDate: dates[dates.length - 1] ?? null,
  };
}

/**
 * Insert in batches rather than one statement per row.
 *
 * A couple of thousand round trips is slow enough to be noticeable on a command
 * someone runs while waiting, and unlike sync there is no rate limit to respect.
 */
async function insertTransactions(
  client: DbClient,
  transactions: readonly SeedTransaction[],
): Promise<void> {
  const COLUMNS = 13;
  const BATCH = 200;

  for (let start = 0; start < transactions.length; start += BATCH) {
    const batch = transactions.slice(start, start + BATCH);
    const values: unknown[] = [];
    const tuples: string[] = [];

    batch.forEach((txn, index) => {
      const base = index * COLUMNS;
      tuples.push(
        `(${Array.from({ length: COLUMNS }, (_, offset) => `$${base + offset + 1}`).join(", ")}, now(), now())`,
      );
      values.push(
        txn.transactionId,
        txn.accountId,
        txn.itemId,
        txn.amount,
        txn.isoCurrencyCode,
        txn.date,
        txn.authorizedDate,
        txn.name,
        txn.merchantName,
        txn.pending,
        txn.paymentChannel,
        JSON.stringify({ primary: txn.pfcPrimary, detailed: txn.pfcDetailed }),
        JSON.stringify(rawPayload(txn)),
      );
    });

    await client.query(
      `INSERT INTO transactions (
         transaction_id, account_id, item_id, amount, iso_currency_code,
         date, authorized_date, name, merchant_name, pending, payment_channel,
         pfc, raw, created_at, updated_at
       ) VALUES ${tuples.join(", ")}`,
      values,
    );
  }
}
