/**
 * Reading the linked banks and their accounts.
 *
 * One read, with one decision in front of it: IS THE DATABASE UP? If it is
 * not, the answer is "the database is not running" and nothing is queried.
 * That is a different thing to tell someone than "the accounts could not be
 * read" — nothing is wrong with the accounts, and the fix is the Start button
 * on another screen — and asking a stopped database would only be a slow way
 * to produce an error that says less.
 *
 * Never throws. What comes back is the rows as the database has them; wording
 * them is presenters/accounts.presenter.ts.
 *
 * No Electron and no domain imports beyond types.
 */

import type { ItemAccountListing } from "../../../../domain/data/repositories/items.repository.js";
import type { DatastoreState } from "../../../../platform/datastore/datastore.js";

export interface AccountsDependencies {
  /** Whether the database server is up. Reads a pid file; never starts anything. */
  state(): Promise<DatastoreState>;
  /** Every bank with every account beneath it, one row per account. */
  list(): Promise<ItemAccountListing[]>;
  /** A safe one-line description of any error — never the error object. */
  describeError(error: unknown): string;
}

export type AccountsReading =
  | { state: "ready"; rows: ItemAccountListing[] }
  | { state: "database-stopped" }
  | { state: "failed"; reason: string };

export class AccountsService {
  constructor(private readonly deps: AccountsDependencies) {}

  async read(): Promise<AccountsReading> {
    try {
      if ((await this.deps.state()) !== "running") return { state: "database-stopped" };
      return { state: "ready", rows: await this.deps.list() };
    } catch (error) {
      return { state: "failed", reason: this.deps.describeError(error) };
    }
  }
}
