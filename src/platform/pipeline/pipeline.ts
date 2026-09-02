/**
 * Pull from a source into the database, one stream at a time.
 *
 * Three properties, and all three are why this exists as a type rather than as
 * a comment inside whichever service happened to need them:
 *
 *   Atomic.      The rows and the checkpoint that describes them commit
 *                together. A crash mid-run rolls back to the previous
 *                checkpoint and the next run re-fetches exactly what was lost.
 *
 *   Idempotent.  Replaying a batch must be a no-op, which is the sink's job —
 *                upsert on the provider's own id, never insert.
 *
 *   Isolated.    One stream failing does not stop the others. A bank that is
 *                down produces one failed result and the rest still run.
 *
 * Nothing here knows what a bank is. What it pulls, what it writes and what a
 * checkpoint means are the three collaborators it is handed.
 */

import type { DataSource } from "../postgres/types/data-source.js";
import type { CheckpointStore } from "./checkpoint-store.js";
import type { Sink } from "./sink.js";
import type { Source } from "./source.js";

/** What happened to one stream. */
export interface PartitionOutcome<Partition, T> {
  partition: Partition;
  ok: boolean;
  /** The batch that was written. Absent when the pull or the write failed. */
  changes?: T;
  error?: unknown;
}

export interface PipelineOptions<Partition> {
  /**
   * Called when one stream fails, before its outcome is recorded.
   *
   * For reactions that belong to the provider rather than to the pipeline —
   * marking a login as expired, say. Its own failure is swallowed: it is a
   * courtesy on an error path and must not replace the error that caused it.
   */
  onFailure?: (partition: Partition, error: unknown) => Promise<void>;
}

export class Pipeline<Partition, T> {
  constructor(
    private readonly db: DataSource,
    private readonly source: Source<Partition, T>,
    private readonly sink: Sink<Partition, T>,
    private readonly checkpoints: CheckpointStore<Partition>,
    private readonly options: PipelineOptions<Partition> = {},
  ) {}

  /** Pull every stream. Never throws — failures come back as outcomes. */
  async run(): Promise<Array<PartitionOutcome<Partition, T>>> {
    const outcomes: Array<PartitionOutcome<Partition, T>> = [];

    for (const partition of await this.source.partitions()) {
      outcomes.push(await this.runOne(partition));
    }

    return outcomes;
  }

  private async runOne(partition: Partition): Promise<PartitionOutcome<Partition, T>> {
    try {
      const batch = await this.source.pull(partition);

      await this.db.transaction(async (tx) => {
        await this.sink.write(tx, partition, batch.changes);
        // Committed with the rows above. This ordering is the entire atomicity
        // argument: the checkpoint is a claim about what those rows contain.
        await this.checkpoints.advance(tx, partition, batch.nextCheckpoint);
      });

      return { partition, ok: true, changes: batch.changes };
    } catch (error) {
      if (this.options.onFailure !== undefined) {
        try {
          await this.options.onFailure(partition, error);
        } catch {
          // Deliberately silent. The original error is the one worth reporting.
        }
      }
      return { partition, ok: false, error };
    }
  }
}
