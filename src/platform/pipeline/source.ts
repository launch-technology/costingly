/**
 * Where data comes from.
 *
 * A source knows how to list the independent streams it can pull — one bank
 * login, one account, one feed — and how to pull each one forward from a
 * checkpoint. It knows nothing about databases.
 *
 * The checkpoint is opaque here on purpose. To this layer it is a string the
 * provider gave us last time and will accept next time; what it means is the
 * provider's business.
 */

/** One pull's worth of changes, and where the next pull should resume. */
export interface Batch<T> {
  changes: T;

  /**
   * The checkpoint to store, or null to leave the stored one alone.
   *
   * Null is not "start over": it means the provider did not give us a usable
   * position this time, and overwriting a good checkpoint with nothing would
   * silently re-request all of history on the next run.
   */
  nextCheckpoint: string | null;
}

export interface Source<Partition, T> {
  /** The streams to pull, in the order they should be attempted. */
  partitions(): Promise<Partition[]>;

  /** Everything that changed since `partition`'s stored checkpoint. */
  pull(partition: Partition): Promise<Batch<T>>;
}
