/**
 * Where each bank's sync got to.
 *
 * Plaid's cursor, stored on the Item. It is a claim that every change Plaid has
 * reported up to that position is already in the transactions table — which is
 * why it advances inside the same transaction as those rows and nowhere else.
 *
 * A null checkpoint is COALESCEd away by the repository rather than written:
 * clearing a good cursor would silently re-request all of history next run.
 */

import type { CheckpointStore } from "../../../platform/pipeline/checkpoint-store.js";
import type { Transaction } from "../../../platform/postgres/types/transaction.js";
import { setItemCursor, type SyncableItem } from "../../data/repositories/items.repository.js";

export class ItemCursorStore implements CheckpointStore<SyncableItem> {
  async advance(tx: Transaction, item: SyncableItem, checkpoint: string | null): Promise<void> {
    await setItemCursor(tx, item.itemId, checkpoint);
  }
}
