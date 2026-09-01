/**
 * A DataSource that opens a connection per unit of work and closes it after.
 *
 * For the superuser. Provisioning has to connect as a role the pool cannot use,
 * sometimes to a database the pool cannot reach, and always before the pool
 * exists — so it cannot be pooled. It must also not be: an idle superuser
 * connection held for the life of the process is a standing privilege nobody
 * asked for, and closing in a `finally` is what stops one existing.
 *
 * The cost is that each `query()` is its own connection as well as its own
 * transaction. Anything needing several statements to share a session — an
 * advisory lock, a session setting — must use `transaction()`.
 */

import type { Client } from "pg";
import { toResult } from "./to-result.js";
import type { DataSource } from "./types/data-source.js";
import type { DbResult } from "./types/db-result.js";
import type { DbRow } from "./types/db-row.js";
import type { Transaction } from "./types/transaction.js";

export class TransientDataSource implements DataSource {
  constructor(
    private readonly connect: () => Promise<Client>,
    private readonly description: string,
  ) {}

  /**
   * One statement on a connection of its own, in autocommit.
   *
   * That is required, not incidental, for `CREATE DATABASE`, which Postgres
   * refuses to run inside a transaction block.
   */
  async query<T extends DbRow = DbRow>(
    text: string,
    params?: readonly unknown[],
  ): Promise<DbResult<T>> {
    return this.session(async (client) =>
      toResult<T>(await client.query(text, params ? [...params] : undefined)),
    );
  }

  /** Run `fn` against one connection, inside BEGIN. */
  async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.session(async (client) => {
      await client.query("BEGIN");
      const tx = {
        query: async (text: string, params?: readonly unknown[]) =>
          toResult(await client.query(text, params ? [...params] : undefined)),
      } as Transaction;

      try {
        const result = await fn(tx);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          console.error(
            "[db] ROLLBACK failed:",
            rollbackError instanceof Error ? rollbackError.message : rollbackError,
          );
        }
        throw error;
      }
    });
  }

  describe(): string {
    return this.description;
  }

  /** Open, run, close — the close in a `finally` so it always happens. */
  private async session<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    const client = await this.connect();
    try {
      return await fn(client);
    } finally {
      await client.end();
    }
  }
}
