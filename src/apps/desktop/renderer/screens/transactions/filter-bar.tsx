/**
 * The Transactions screen's filters: an account, two dates, and a search box.
 *
 * Drawing only. The dates are the browser's own date fields, which hand back
 * a calendar day as "YYYY-MM-DD" or nothing — exactly what is sent on, with
 * no date ever worked out here.
 */

import type { AccountOption } from "../../../bridge/contract.js";
import { Button } from "../../components/button.js";
import type { TransactionFilters } from "../../hooks/use-transactions.js";

const FIELD =
  "rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900";
const LABEL = "mb-1 block text-xs font-medium text-slate-600 dark:text-slate-300";

export interface FilterBarProps {
  filters: TransactionFilters;
  accounts: AccountOption[];
  filtered: boolean;
  onChange(change: Partial<TransactionFilters>): void;
  onClear(): void;
}

export function FilterBar({ filters, accounts, filtered, onChange, onClear }: FilterBarProps) {
  return (
    <div data-testid="transaction-filters" className="mb-4 flex flex-wrap items-end gap-3">
      <div>
        <label htmlFor="filter-account" className={LABEL}>
          Account
        </label>
        <select
          id="filter-account"
          data-testid="filter-account"
          value={filters.accountId}
          onChange={(event) => onChange({ accountId: event.target.value })}
          className={`${FIELD} max-w-64`}
        >
          <option value="">All accounts</option>
          {accounts.map((account) => (
            <option key={account.id} value={account.id}>
              {account.label}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor="filter-from" className={LABEL}>
          From
        </label>
        <input
          id="filter-from"
          data-testid="filter-from"
          type="date"
          value={filters.from}
          onChange={(event) => onChange({ from: event.target.value })}
          className={FIELD}
        />
      </div>

      <div>
        <label htmlFor="filter-to" className={LABEL}>
          To
        </label>
        <input
          id="filter-to"
          data-testid="filter-to"
          type="date"
          value={filters.to}
          onChange={(event) => onChange({ to: event.target.value })}
          className={FIELD}
        />
      </div>

      <div className="min-w-48 flex-1">
        <label htmlFor="filter-text" className={LABEL}>
          Search
        </label>
        <input
          id="filter-text"
          data-testid="filter-text"
          type="search"
          value={filters.text}
          placeholder="Description or merchant"
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => onChange({ text: event.target.value })}
          className={`${FIELD} w-full`}
        />
      </div>

      {filtered && (
        <Button variant="secondary" data-testid="filters-clear" onClick={onClear}>
          Clear filters
        </Button>
      )}
    </div>
  );
}
