/**
 * One bank on the Accounts screen: its name, and its accounts as rows.
 *
 * Drawing only. Every string here arrives ready to show — the main process
 * has already worded the type and formatted the balance.
 */

import type { BankView } from "../../../bridge/contract.js";

export function BankCard({ bank }: { bank: BankView }) {
  return (
    <section
      data-testid="bank"
      data-bank-name={bank.name}
      className="rounded-lg border border-slate-200 p-4 dark:border-slate-800"
    >
      <header className="mb-3 flex items-center gap-2">
        <h2 data-testid="bank-name" className="text-base font-semibold">
          {bank.name}
        </h2>
        {bank.sample && (
          <span
            data-testid="bank-sample"
            className="rounded bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-900 dark:bg-amber-900 dark:text-amber-100"
          >
            Sample data
          </span>
        )}
      </header>

      {bank.accounts.length === 0 ? (
        <p data-testid="bank-no-accounts" className="text-sm text-slate-600 dark:text-slate-300">
          This bank has no accounts.
        </p>
      ) : (
        <ul className="divide-y divide-slate-200 dark:divide-slate-800">
          {bank.accounts.map((account) => (
            <li key={account.id} data-testid="account" className="flex items-baseline justify-between gap-4 py-2">
              <div className="min-w-0">
                <p data-testid="account-name" className="truncate text-sm font-medium">
                  {account.name}
                </p>
                <p data-testid="account-detail" className="text-xs text-slate-600 dark:text-slate-300">
                  {[account.type, account.lastFour === "" ? "" : `••••${account.lastFour}`]
                    .filter((part) => part !== "")
                    .join(" · ")}
                </p>
              </div>
              <p data-testid="account-balance" className="shrink-0 text-sm tabular-nums">
                {account.balance}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
