/**
 * Writing one item's changes into costingly's tables.
 *
 * Order is a foreign key, not a preference: `transactions.account_id` references
 * `accounts`, and a new account can appear in the same batch as its first
 * transaction.
 *
 * Every write is an upsert keyed on the provider's own id, which is what makes
 * replaying a batch a no-op — the idempotence the pipeline's re-run safety
 * depends on.
 */

import type { Transaction as PlaidTransaction } from "plaid";

import type { Sink } from "../../../platform/pipeline/sink.js";
import type { Transaction } from "../../../platform/postgres/types/transaction.js";
import { upsertMany as upsertAccountRows } from "../../data/repositories/accounts.repository.js";
import { deleteByIds, upsertMany } from "../../data/repositories/transactions.repository.js";
import type { SyncableItem } from "../../data/repositories/items.repository.js";
import { toAccountRow, toTransactionRow } from "./plaid.mappers.js";
import type { ItemChanges } from "./plaid.source.js";

export class TransactionsSink implements Sink<SyncableItem, ItemChanges> {
  async write(tx: Transaction, item: SyncableItem, changes: ItemChanges): Promise<void> {
    await upsertAccountRows(
      tx,
      changes.accounts.map((account) => toAccountRow(account, item.itemId)),
    );

    const upserts = dedupe(changes.added, changes.modified);
    await upsertMany(
      tx,
      upserts.map((transaction) => toTransactionRow(transaction, item.itemId)),
    );

    await deleteByIds(
      tx,
      changes.removed.map((entry) => entry.transaction_id),
    );
  }
}

/**
 * Collapse `added` + `modified` into one write set, keyed by transaction_id.
 *
 * Plaid can report the same transaction more than once across pages, and a
 * transaction can appear in both lists within a single run. Postgres rejects an
 * ON CONFLICT DO UPDATE that touches the same row twice, so this is required,
 * not tidiness. The last version seen is the current one.
 */
function dedupe(...lists: ReadonlyArray<readonly PlaidTransaction[]>): PlaidTransaction[] {
  const byId = new Map<string, PlaidTransaction>();
  for (const list of lists) {
    for (const transaction of list) byId.set(transaction.transaction_id, transaction);
  }
  return [...byId.values()];
}
