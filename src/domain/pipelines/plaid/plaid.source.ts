/**
 * Pulling transaction changes out of Plaid.
 *
 * One partition per linked bank. Paging, restart-on-mutation and the shape of
 * Plaid's cursor all live here — the pipeline above knows only that it asked for
 * changes and got a batch back.
 */

import type {
  AccountBase,
  RemovedTransaction,
  Transaction,
  TransactionsSyncRequest,
  TransactionsUpdateStatus,
} from "plaid";

import type { Batch, Source } from "../../../platform/pipeline/source.js";
import { db } from "../../data/default-database.js";
import { listSyncableItems, type SyncableItem } from "../../data/repositories/items.repository.js";
import { getPlaidClient, isMutationDuringPagination } from "../../data/plaid.client.js";

/** Plaid's maximum page size for /transactions/sync. */
const PAGE_SIZE = 500;

/** How many times to restart pagination after a mid-pagination mutation. */
const MAX_PAGINATION_RESTARTS = 5;

/** Safety valve so a misbehaving `has_more` can never loop forever. */
const MAX_PAGES_PER_ATTEMPT = 1000;

/** Everything one item's pull produced. */
export interface ItemChanges {
  added: Transaction[];
  modified: Transaction[];
  removed: RemovedTransaction[];
  accounts: AccountBase[];
  pages: number;
  updateStatus: TransactionsUpdateStatus | null;
}

export class PlaidSource implements Source<SyncableItem, ItemChanges> {
  /**
   * Every Item with a bank behind it, oldest-synced first.
   *
   * SyncableItem, not StoredItem: an Item with no bank (source 'seed') has
   * nothing to pull, and the type says so rather than a guard noticing later.
   */
  async partitions(): Promise<SyncableItem[]> {
    return listSyncableItems(db);
  }

  /**
   * Page through /transactions/sync until Plaid says there is nothing more.
   *
   * If Plaid reports TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION, the pages
   * already collected may be inconsistent with each other, so everything
   * accumulated is discarded and the whole walk restarts from the stored
   * cursor — never an intermediate one. The accumulators are declared *inside*
   * the attempt loop, so that reset is structural rather than something a
   * future edit can forget to do.
   */
  async pull(item: SyncableItem): Promise<Batch<ItemChanges>> {
    const plaid = getPlaidClient();

    for (let attempt = 0; attempt <= MAX_PAGINATION_RESTARTS; attempt += 1) {
      const added: Transaction[] = [];
      const modified: Transaction[] = [];
      const removed: RemovedTransaction[] = [];
      const accountsById = new Map<string, AccountBase>();

      let cursor: string | null = item.cursor;
      let updateStatus: TransactionsUpdateStatus | null = null;
      let pages = 0;
      let hasMore = true;

      try {
        while (hasMore) {
          if (pages >= MAX_PAGES_PER_ATTEMPT) {
            throw new Error(
              `Aborting after ${MAX_PAGES_PER_ATTEMPT} pages — Plaid kept reporting has_more.`,
            );
          }

          const request: TransactionsSyncRequest = {
            access_token: item.accessToken,
            count: PAGE_SIZE,
          };
          // Omitting `cursor` entirely is what asks Plaid for the full history.
          // Sending `cursor: null` is not the same thing and is rejected.
          if (cursor !== null && cursor !== "") {
            request.cursor = cursor;
          }

          const { data } = await plaid.transactionsSync(request);
          pages += 1;

          added.push(...data.added);
          modified.push(...data.modified);
          removed.push(...data.removed);

          // Later pages carry fresher balances; keying by id keeps the last.
          for (const account of data.accounts) {
            accountsById.set(account.account_id, account);
          }

          cursor = data.next_cursor;
          hasMore = data.has_more;
          updateStatus = data.transactions_update_status;
        }

        return {
          changes: {
            added,
            modified,
            removed,
            accounts: [...accountsById.values()],
            pages,
            updateStatus,
          },
          // An empty next_cursor means "no cursor yet" (Plaid is still doing
          // the Item's first historical pull). Normalising it to null keeps it
          // from being persisted as a bogus cursor.
          nextCheckpoint: cursor !== null && cursor !== "" ? cursor : null,
        };
      } catch (error) {
        if (isMutationDuringPagination(error) && attempt < MAX_PAGINATION_RESTARTS) {
          console.warn(
            `[sync] transactions mutated mid-pagination; discarding ${
              added.length + modified.length + removed.length
            } buffered change(s) and restarting from the stored cursor ` +
              `(attempt ${attempt + 1}/${MAX_PAGINATION_RESTARTS})`,
          );
          continue;
        }
        throw error;
      }
    }

    throw new Error(
      `Gave up after ${MAX_PAGINATION_RESTARTS} restarts: transactions kept mutating during pagination.`,
    );
  }
}
