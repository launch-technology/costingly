/**
 * The Transactions screen's one call: find transactions.
 *
 * Read-only. What arrives is a query from the window, and this is a process
 * boundary, so it is rebuilt field by field into the filter the domain takes:
 * a string stays a string, anything else becomes "no filter", and the limit
 * falls back to the domain's default. What the filter then MEANS — whether a
 * date is a real day, how text is matched — is the domain's to decide.
 */

import type { TransactionFilter } from "../../../../domain/services/transactions/transaction-search.service.js";
import { presentTransactions } from "../presenters/transactions.presenter.js";
import type { TransactionsService } from "../services/transactions.service.js";
import type { Controller, HandlersFor } from "./controller.js";

export class TransactionsController implements Controller<"transactions"> {
  constructor(
    private readonly transactions: TransactionsService,
    /** How many to show when the window does not say. The domain's own default. */
    private readonly defaultLimit: number,
  ) {}

  handlers(): HandlersFor<"transactions"> {
    return {
      "transactions.find": async (query) => {
        const filter = toFilter(query, this.defaultLimit);
        return presentTransactions(await this.transactions.read(filter), filter);
      },
    };
  }
}

function toFilter(query: unknown, defaultLimit: number): TransactionFilter {
  const given = (typeof query === "object" && query !== null ? query : {}) as Record<string, unknown>;
  const text = (name: string): string => (typeof given[name] === "string" ? (given[name] as string) : "");
  const orNone = (value: string): string | null => (value === "" ? null : value);

  const limit = given["limit"];
  return {
    accountId: orNone(text("accountId")),
    from: orNone(text("from")),
    to: orNone(text("to")),
    text: text("text"),
    limit: typeof limit === "number" && Number.isInteger(limit) && limit > 0 ? limit : defaultLimit,
  };
}
