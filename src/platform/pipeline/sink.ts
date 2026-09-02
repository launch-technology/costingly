/**
 * Where data goes.
 *
 * Writes one batch. Always given a transaction, never a pool: the write and the
 * checkpoint advance that describes it have to commit together, and a sink that
 * could choose its own executor would be able to break that.
 */

import type { Transaction } from "../postgres/types/transaction.js";

export interface Sink<Partition, T> {
  write(tx: Transaction, partition: Partition, changes: T): Promise<void>;
}
