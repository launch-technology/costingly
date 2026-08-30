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

import { withTransaction } from "../../data/db/queries.js";
import { saveItem, countBySource, deleteBySource } from "../../data/repositories/items.repository.js";
import { upsertMany as upsertAccountRows } from "../../data/repositories/accounts.repository.js";
import {
  upsertMany,
  type TransactionRow,
} from "../../data/repositories/transactions.repository.js";
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
  const linked = await countBySource("plaid");
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

  await deleteBySource("seed");

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
    await upsertAccountRows(
      client,
      dataset.accounts.map((account) => ({
        accountId: account.accountId,
        itemId: account.itemId,
        name: account.name,
        officialName: account.officialName,
        mask: account.mask,
        type: account.type,
        subtype: account.subtype,
        currency: account.currency,
        currentBalance: account.currentBalance,
        availableBalance: account.availableBalance,
      })),
    );
    await upsertMany(client, dataset.transactions.map(toRow));
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
 * A generated transaction, flattened into the row the repository stores.
 *
 * Seeded rows carry no legacy `category` array — Plaid replaced it with the
 * personal finance category, and fabricating a deprecated field would teach a
 * query the wrong lesson.
 */
function toRow(txn: SeedTransaction): TransactionRow {
  return {
    transactionId: txn.transactionId,
    accountId: txn.accountId,
    itemId: txn.itemId,
    amount: txn.amount,
    isoCurrencyCode: txn.isoCurrencyCode,
    date: txn.date,
    authorizedDate: txn.authorizedDate,
    name: txn.name,
    merchantName: txn.merchantName,
    pending: txn.pending,
    paymentChannel: txn.paymentChannel,
    category: null,
    pfc: JSON.stringify({ primary: txn.pfcPrimary, detailed: txn.pfcDetailed }),
    raw: JSON.stringify(rawPayload(txn)),
  };
}
