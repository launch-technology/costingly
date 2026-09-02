/**
 * The recurring sync: refresh every linked bank from Plaid.
 *
 * All of the *mechanism* — paging, atomic write-and-advance, one failure not
 * stopping the rest — is the pipeline's. What remains here is costingly's part
 * of it: which pipeline to build, what to do when a bank needs re-authenticating,
 * and how to report the run to a person or a model.
 *
 * The two properties everything downstream relies on are enforced by the pieces
 * this composes rather than by anything written here:
 *
 *   Idempotent — the sink upserts on `transaction_id`, so running the sync twice
 *                in a row adds nothing.
 *   Atomic     — the cursor advances in the same transaction as the rows it
 *                describes, so a crash mid-run re-fetches exactly what was lost.
 */

import { Pipeline } from "../../../platform/pipeline/pipeline.js";
import { db } from "../../data/default-database.js";
import { setItemStatus, type SyncableItem } from "../../data/repositories/items.repository.js";
import { describeError, isItemLoginRequired } from "../../data/plaid.client.js";
import { ItemCursorStore } from "../../pipelines/plaid/item-cursor.store.js";
import { PlaidSource, type ItemChanges } from "../../pipelines/plaid/plaid.source.js";
import { TransactionsSink } from "../../pipelines/plaid/transactions.sink.js";
import type { ItemSyncResult, SyncSummary } from "./sync.types.js";

/**
 * Flag an Item whose login has expired.
 *
 * Not the pipeline's business: it is a Plaid-specific reaction that stops the
 * nightly run retrying a bank only the user can fix. `costingly link` repairs it.
 */
async function markLoginRequired(item: SyncableItem, error: unknown): Promise<void> {
  if (!isItemLoginRequired(error)) return;
  await setItemStatus(db, item.itemId, "login_required");
}

/**
 * Sync every active Item and return a summary.
 *
 * The single entry point shared by `costingly sync` and the MCP tool — neither
 * adds logic on top of it.
 */
export async function syncAllItems(): Promise<SyncSummary> {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();

  const pipeline = new Pipeline<SyncableItem, ItemChanges>(
    db,
    new PlaidSource(),
    new TransactionsSink(),
    new ItemCursorStore(),
    {
      onFailure: async (item, error) => {
        try {
          await markLoginRequired(item, error);
        } catch (statusError) {
          console.error(
            `[sync] failed to mark item ${item.itemId} as login_required:`,
            describeError(statusError),
          );
        }
      },
    },
  );

  const results = (await pipeline.run()).map(toItemResult);

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

/** One pipeline outcome, in the shape both interfaces already render. */
function toItemResult(outcome: {
  partition: SyncableItem;
  ok: boolean;
  changes?: ItemChanges;
  error?: unknown;
}): ItemSyncResult {
  const base = {
    itemId: outcome.partition.itemId,
    institutionName: outcome.partition.institutionName,
    // A null cursor before the run means Plaid had never been asked for this
    // bank's history, which is what makes the first run take minutes.
    initialBackfill: outcome.partition.cursor === null,
  };

  const changes = outcome.changes;
  if (!outcome.ok || changes === undefined) {
    return {
      ...base,
      ok: false,
      added: 0,
      modified: 0,
      removed: 0,
      accounts: 0,
      pages: 0,
      updateStatus: null,
      error: describeError(outcome.error),
    };
  }

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
}
