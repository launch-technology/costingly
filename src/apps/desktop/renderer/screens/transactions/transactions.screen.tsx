/**
 * The Transactions screen: the newest transactions, narrowed by account,
 * dates and search text.
 *
 * Drawing only; the filters and when the list is re-read are
 * hooks/use-transactions.ts. Read-only — nothing here changes a transaction.
 *
 * What it can be showing:
 *
 *   loading            the first answer has not come back
 *   rows               with how many match and how many are shown
 *   no rows            and WHY: no bank, nothing synced, nothing matching, or
 *                      dates the wrong way round — each its own message
 *   database stopped   says so, and where to start it
 *   failed             what went wrong and what to do
 *
 * The filters stay on screen in every state but the last two and "no bank":
 * a search that found nothing is fixed with the same controls that caused it.
 */

import type { NoTransactions, Problem } from "../../../bridge/contract.js";
import { Alert } from "../../components/alert.js";
import { Button } from "../../components/button.js";
import { useTransactions } from "../../hooks/use-transactions.js";
import { FilterBar } from "./filter-bar.js";
import { TransactionTable } from "./transaction-table.js";

export function TransactionsScreen() {
  const transactions = useTransactions();
  const { filters, filtered } = transactions;

  const view = transactions.state.phase === "loaded" ? transactions.state.view : null;
  const ready = view !== null && view.state === "ready" ? view : null;
  const state =
    view === null ? "loading" : ready === null ? view.state : ready.empty === undefined ? "rows" : ready.empty.reason;
  // Without a bank or a single transaction there is nothing to filter.
  const showFilters = ready !== null && state !== "no-banks" && state !== "nothing-synced";

  return (
    <section
      data-testid="transactions-screen"
      data-state={state}
      data-refreshing={transactions.refreshing ? "true" : "false"}
    >
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Transactions</h1>
      </header>

      {view === null && (
        <p data-testid="transactions-loading" className="text-sm text-slate-600 dark:text-slate-300">
          Loading transactions…
        </p>
      )}

      {view?.state === "database-stopped" && (
        <div data-testid="transactions-database-stopped" className="text-sm">
          <p className="mb-1 text-lg">The database is not running.</p>
          <p className="text-slate-600 dark:text-slate-300">
            Your transactions are stored in it. Start it from the Status screen, then come back here.
          </p>
        </div>
      )}

      {view?.state === "failed" && (
        <>
          <ProblemAlert problem={view.problem} />
          <Button variant="secondary" data-testid="transactions-retry" onClick={transactions.reload}>
            Try again
          </Button>
        </>
      )}

      {ready !== null && showFilters && (
        <FilterBar
          filters={filters}
          accounts={ready.accounts}
          filtered={filtered}
          onChange={transactions.setFilter}
          onClear={transactions.clearFilters}
        />
      )}

      {ready !== null && ready.empty !== undefined && (
        <NoRows why={ready.empty} filtered={filtered} onClear={transactions.clearFilters} />
      )}

      {ready !== null && ready.rows.length > 0 && (
        <>
          <p data-testid="transactions-count" className="mb-2 text-sm text-slate-600 dark:text-slate-300">
            {countLine(ready.rows.length, ready.total)}
          </p>
          <TransactionTable rows={ready.rows} />
          {ready.rows.length < ready.total && (
            <div className="mt-4 text-center">
              <Button
                variant="secondary"
                data-testid="transactions-more"
                onClick={transactions.showMore}
                disabled={transactions.refreshing}
              >
                {transactions.refreshing ? "Loading…" : "Show more"}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function countLine(shown: number, total: number): string {
  const count = (value: number): string => new Intl.NumberFormat().format(value);
  if (shown >= total) return total === 1 ? "1 transaction" : `${count(total)} transactions`;
  return `Showing the newest ${count(shown)} of ${count(total)} transactions`;
}

function NoRows({ why, filtered, onClear }: { why: NoTransactions; filtered: boolean; onClear(): void }) {
  switch (why.reason) {
    case "no-banks":
      return (
        <Message testId="transactions-no-banks" title="No bank is linked yet.">
          Link a bank from the Accounts screen, then sync it to see its transactions here.
        </Message>
      );
    case "nothing-synced":
      return (
        <Message testId="transactions-nothing-synced" title="No transactions yet.">
          Sync your banks from the Accounts screen to bring their transactions in.
        </Message>
      );
    case "invalid-range":
      return (
        <Message testId="transactions-invalid-range" title="Those dates are the wrong way round.">
          The From date is after the To date. Change one of them to see transactions.
        </Message>
      );
    case "no-match":
      return (
        <Message testId="transactions-no-match" title="No transactions match.">
          {why.hint !== "" && <span data-testid="transactions-no-match-hint">{why.hint} </span>}
          {filtered && (
            <Button variant="link" data-testid="transactions-no-match-clear" onClick={onClear}>
              Clear filters
            </Button>
          )}
        </Message>
      );
  }
}

function Message({ testId, title, children }: { testId: string; title: string; children: React.ReactNode }) {
  return (
    <div data-testid={testId} className="max-w-lg">
      <p className="mb-1 text-lg">{title}</p>
      <p className="text-sm text-slate-600 dark:text-slate-300">{children}</p>
    </div>
  );
}

function ProblemAlert({ problem }: { problem: Problem }) {
  return (
    <Alert data-testid="transactions-problem" title={problem.cause}>
      <p data-testid="transactions-problem-next-step" className="mt-1">
        {problem.nextStep}
      </p>
    </Alert>
  );
}
