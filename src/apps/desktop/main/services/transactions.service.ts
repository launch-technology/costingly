/**
 * Reading transactions for the Transactions screen.
 *
 * Finding them — the filters, the order, the limit — is the domain's, and is
 * called here as it is. This is only what a window in a long-running app
 * needs around that, the same two things the accounts service does:
 *
 *   IS THE DATABASE UP? If not, the answer is "the database is not running"
 *   and nothing is queried. Nothing is wrong with the transactions; the fix
 *   is a button on another screen.
 *
 *   NEVER THROW. A read that fails is described and handed back.
 *
 * It also fetches the accounts to filter by, from the same listing the
 * Accounts screen is drawn from, so an account is named identically in both.
 *
 * No Electron and no domain imports beyond types.
 */

import type { ItemAccountListing } from "../../../../domain/data/repositories/items.repository.js";
import type {
  TransactionFilter,
  TransactionsFound,
} from "../../../../domain/services/transactions/transaction-search.service.js";
import type { DatastoreState } from "../../../../platform/datastore/datastore.js";

export interface TransactionsDependencies {
  /** Whether the database server is up. Reads a pid file; never starts anything. */
  state(): Promise<DatastoreState>;
  /** The domain's search. */
  find(filter: TransactionFilter): Promise<TransactionsFound>;
  /** Every bank with every account beneath it, one row per account. */
  listAccounts(): Promise<ItemAccountListing[]>;
  /** A safe one-line description of any error — never the error object. */
  describeError(error: unknown): string;
}

export type TransactionsReading =
  | { state: "ready"; found: TransactionsFound; accounts: ItemAccountListing[] }
  | { state: "database-stopped" }
  | { state: "failed"; reason: string };

export class TransactionsService {
  constructor(private readonly deps: TransactionsDependencies) {}

  async read(filter: TransactionFilter): Promise<TransactionsReading> {
    try {
      if ((await this.deps.state()) !== "running") return { state: "database-stopped" };
      const [found, accounts] = await Promise.all([this.deps.find(filter), this.deps.listAccounts()]);
      return { state: "ready", found, accounts };
    } catch (error) {
      return { state: "failed", reason: this.deps.describeError(error) };
    }
  }
}
