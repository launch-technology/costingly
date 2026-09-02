/**
 * How far each stream has been pulled.
 *
 * The single most important contract in the pipeline. A checkpoint is a CLAIM
 * that everything the provider reported up to that position is already written —
 * so it must be advanced in the same transaction as the rows it describes.
 *
 * Advance it without the rows and the provider never resends them: the data is
 * gone until the stream is re-established from scratch. That is why `advance`
 * takes a Transaction and not an Executor.
 */

import type { Transaction } from "../postgres/types/transaction.js";

export interface CheckpointStore<Partition> {
  advance(tx: Transaction, partition: Partition, checkpoint: string | null): Promise<void>;
}
