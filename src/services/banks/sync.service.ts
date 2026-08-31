/**
 * The recurring sync.
 *
 * For each stored Item: page through /transactions/sync until `has_more` is
 * false, then apply everything — accounts, added/modified upserts, removals,
 * and the new cursor — inside one database transaction.
 *
 * Two properties follow from that, and both are load-bearing:
 *
 *   Idempotent. Upserts are keyed on `transaction_id`, so replaying the same
 *   changes is a no-op. Running the sync twice in a row adds nothing.
 *
 *   Atomic. The cursor advances in the same transaction as the rows it
 *   describes. A crash mid-run rolls back to the previous cursor and the next
 *   run re-fetches exactly the changes that were lost — never skipping them,
 *   never double-applying them.
 */

import type {
  AccountBase,
  RemovedTransaction,
  Transaction,
  TransactionsSyncRequest,
  TransactionsUpdateStatus,
} from "plaid";
import type { DbClient } from "../../data/db/queries.js";
import type { ItemSyncResult, SyncSummary } from "./sync.types.js";
import { withTransaction } from "../../data/db/queries.js";
import { upsertMany, deleteByIds } from "../../data/repositories/transactions.repository.js";
import { upsertMany as upsertAccountRows } from "../../data/repositories/accounts.repository.js";
import { toTransactionRow, toAccountRow } from "./plaid.mappers.js";
import {
  listSyncableItems,
  setItemCursor,
  setItemStatus,
  type SyncableItem,
} from "../../data/repositories/items.repository.js";
import {
  describeError,
  getPlaidClient,
  isItemLoginRequired,
  isMutationDuringPagination,
} from "../../data/plaid.client.js";

/** Plaid's maximum page size for /transactions/sync. */
const PAGE_SIZE = 500;

/** How many times to restart pagination after a mid-pagination mutation. */
const MAX_PAGINATION_RESTARTS = 5;

/** Safety valve so a misbehaving `has_more` can never loop forever. */
const MAX_PAGES_PER_ATTEMPT = 1000;


// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

interface ItemChanges {
  added: Transaction[];
  modified: Transaction[];
  removed: RemovedTransaction[];
  accounts: AccountBase[];
  nextCursor: string | null;
  pages: number;
  updateStatus: TransactionsUpdateStatus | null;
}

/**
 * Page through /transactions/sync until Plaid says there is nothing more.
 *
 * If Plaid reports TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION, the pages we
 * already collected may be inconsistent with each other, so everything
 * accumulated is discarded and the whole walk restarts from `startCursor` —
 * the cursor last committed to the database, never an intermediate one. The
 * accumulators are declared *inside* the attempt loop, so that reset is
 * structural rather than something a future edit can forget to do.
 */
async function fetchItemChanges(
  accessToken: string,
  startCursor: string | null,
): Promise<ItemChanges> {
  const plaid = getPlaidClient();

  for (let attempt = 0; attempt <= MAX_PAGINATION_RESTARTS; attempt += 1) {
    const added: Transaction[] = [];
    const modified: Transaction[] = [];
    const removed: RemovedTransaction[] = [];
    const accountsById = new Map<string, AccountBase>();

    let cursor: string | null = startCursor;
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
          access_token: accessToken,
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

        // Later pages carry fresher balances; keying by id keeps the last one.
        for (const account of data.accounts) {
          accountsById.set(account.account_id, account);
        }

        cursor = data.next_cursor;
        hasMore = data.has_more;
        updateStatus = data.transactions_update_status;
      }

      return {
        added,
        modified,
        removed,
        accounts: [...accountsById.values()],
        // An empty next_cursor means "no cursor yet" (Plaid is still doing the
        // Item's first historical pull). Normalising it to null keeps it from
        // being persisted as a bogus cursor.
        nextCursor: cursor !== null && cursor !== "" ? cursor : null,
        pages,
        updateStatus,
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

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------



/**
 * Collapse `added` + `modified` into one write set, keyed by transaction_id.
 *
 * Plaid can report the same transaction more than once across pages, and a
 * transaction can appear in both lists within a single run. The last version
 * seen is the current one.
 */
function dedupeTransactions(...lists: ReadonlyArray<readonly Transaction[]>): Transaction[] {
  const byId = new Map<string, Transaction>();
  for (const list of lists) {
    for (const transaction of list) {
      byId.set(transaction.transaction_id, transaction);
    }
  }
  return [...byId.values()];
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Sync a single Item. Never throws — failures come back as `ok: false`.
 *
 * Takes a SyncableItem, not a StoredItem: an Item with no bank behind it
 * (source 'seed') has nothing to sync, and the type says so rather than a guard
 * having to notice at runtime.
 */
async function syncItem(item: SyncableItem): Promise<ItemSyncResult> {
  const initialBackfill = item.cursor === null;

  const base = {
    itemId: item.itemId,
    institutionName: item.institutionName,
    initialBackfill,
  };

  try {
    const changes = await fetchItemChanges(item.accessToken, item.cursor);
    const upserts = dedupeTransactions(changes.added, changes.modified);

    await withTransaction(async (client) => {
      // Order matters: accounts first, because transactions.account_id is a
      // foreign key into accounts and a new account may appear in this batch.
      await upsertAccountRows(client, changes.accounts.map((a) => toAccountRow(a, item.itemId)));
      await upsertMany(client, upserts.map((t) => toTransactionRow(t, item.itemId)));
      await deleteByIds(client, changes.removed.map((entry) => entry.transaction_id));
      // Committed together with the rows above — this is the atomicity that
      // makes a re-run safe.
      await setItemCursor(client, item.itemId, changes.nextCursor);
    });

    return {
      ...base,
      ok: true,
      added: changes.added.length,
      modified: changes.modified.length,
      removed: changes.removed.length,
      accounts: changes.accounts.length,
      pages: changes.pages,
      updateStatus: changes.updateStatus,
    };
  } catch (error) {
    // The Item needs the user to re-authenticate. Flag it so the nightly run
    // stops retrying and `costingly link` can repair it.
    if (isItemLoginRequired(error)) {
      try {
        await setItemStatus(item.itemId, "login_required");
      } catch (statusError) {
        console.error(
          `[sync] failed to mark item ${item.itemId} as login_required:`,
          describeError(statusError),
        );
      }
    }

    return {
      ...base,
      ok: false,
      added: 0,
      modified: 0,
      removed: 0,
      accounts: 0,
      pages: 0,
      updateStatus: null,
      error: describeError(error),
    };
  }
}

/**
 * Sync every active Item and return a summary.
 *
 * This is the single entry point shared by the local CLI (`costingly sync`) and
 * any other caller — neither adds logic on top of it.
 *
 * Items are processed one at a time and independently: a bank that is down,
 * rate-limited, or needs re-authentication produces one failed result and the
 * remaining items still sync.
 */
export async function syncAllItems(): Promise<SyncSummary> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  const items = await listSyncableItems();
  const results: ItemSyncResult[] = [];

  for (const item of items) {
    results.push(await syncItem(item));
  }

  const finishedAtMs = Date.now();
  const succeeded = results.filter((result) => result.ok);

  return {
    ok: results.every((result) => result.ok),
    startedAt,
    finishedAt: new Date(finishedAtMs).toISOString(),
    durationMs: finishedAtMs - startedAtMs,
    itemsTotal: results.length,
    itemsSucceeded: succeeded.length,
    itemsFailed: results.length - succeeded.length,
    added: results.reduce((total, result) => total + result.added, 0),
    modified: results.reduce((total, result) => total + result.modified, 0),
    removed: results.reduce((total, result) => total + result.removed, 0),
    results,
  };
}
