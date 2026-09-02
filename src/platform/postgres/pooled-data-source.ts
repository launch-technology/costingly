/**
 * A DataSource backed by a connection pool.
 *
 * Knows nothing about which database it points at or how one gets provisioned:
 * it is handed a function that produces a pool and calls it once, on the first
 * query. Deciding what to hand it is the registry's job.
 *
 * Opening is lazy for a reason that outlives this class. `costingly doctor`
 * exists to diagnose a cluster that will not start, so constructing a
 * DataSource must never start one.
 */

import type { Pool } from "pg";
import { toResult } from "./to-result.js";
import type { DataSource } from "./types/data-source.js";
import type { DbResult } from "./types/db-result.js";
import type { DbRow } from "./types/db-row.js";
import type { Transaction } from "./types/transaction.js";

export class PooledDataSource implements DataSource {
  private opening: Promise<Pool> | undefined;

  constructor(
    private readonly open: () => Promise<Pool>,
    private readonly description: string,
  ) {}

  /** True once something has actually opened the pool. */
  isOpen(): boolean {
    return this.opening !== undefined;
  }

  /**
   * Runs on a connection the pool picks per call, so each statement is its own
   * implicit transaction. For anything that must succeed or fail together, use
   * `transaction`.
   */
  async query<T extends DbRow = DbRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<DbResult<T>> {
    const pool = await this.pool();
    return toResult<T>(await pool.query(text, params ? [...params] : undefined));
  }

  /**
   * Run `fn` inside a single transaction.
   *
   * Every write for a given Plaid Item goes through here, so a run either
   * applies all of that item's changes *and* advances its cursor, or applies
   * none of them. There is no state where the cursor has moved past changes
   * that were never written — which is what makes the sync safely re-runnable.
   */
  async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    const pool = await this.pool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // The cast is one of only two places a Transaction is minted. Everything
      // the brand promises — that this executor is inside BEGIN — is true here.
      const tx = {
        query: async (text: string, params?: readonly unknown[]) =>
          toResult(await client.query(text, params ? [...params] : undefined)),
      } as Transaction;

      const result = await fn(tx);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        // Never let a failed rollback replace the error that caused it: the
        // original is the one worth reading, and a dead connection is the
        // usual reason both happened.
        console.error(
          "[db] ROLLBACK failed:",
          rollbackError instanceof Error ? rollbackError.message : rollbackError,
        );
      }
      throw error;
    } finally {
      client.release();
    }
  }

  describe(): string {
    return this.description;
  }

  /** Close the pool, if one was ever opened. Safe to call more than once. */
  async close(): Promise<void> {
    const pending = this.opening;
    if (!pending) return;
    this.opening = undefined;
    try {
      await (await pending).end();
    } catch {
      // The pool never opened. Whatever went wrong was already reported by the
      // command that triggered it; teardown must not report it twice.
    }
  }

  private pool(): Promise<Pool> {
    const existing = this.opening;
    if (existing) return existing;

    const created = this.open().catch((error: unknown) => {
      // Do not keep a rejected promise: it would re-throw on every later call,
      // including from close() in the teardown path, where it surfaces as an
      // unhandled rejection on top of the real error.
      this.opening = undefined;
      throw error;
    });
    this.opening = created;
    return created;
  }
}
