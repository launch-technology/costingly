/**
 * The Transactions screen's wiring: the real domain, fitted to what the
 * transactions service asks for. WIRING ONLY — the domain's search, account
 * listing and page size, handed over as they are. No Electron.
 */

import { adminDataSource } from "../../../../../domain/data/default-database.js";
import { listWithAccounts } from "../../../../../domain/data/repositories/items.repository.js";
import { server } from "../../../../../domain/project.js";
import {
  DEFAULT_TRANSACTION_LIMIT,
  findTransactions,
} from "../../../../../domain/services/transactions/transaction-search.service.js";
import { describeError } from "../../shared/domain.adapter.js";
import type { TransactionsDependencies } from "./transactions.service.js";

/**
 * What the Transactions screen is read from: the domain's own search, the
 * same account listing the Accounts screen uses, and the domain's own page
 * size.
 */
export function transactionsDependencies(): TransactionsDependencies {
  return {
    state: () => server.status(),
    find: findTransactions,
    listAccounts: () => listWithAccounts(adminDataSource()),
    describeError,
  };
}
export const transactionsPageSize = DEFAULT_TRANSACTION_LIMIT;
