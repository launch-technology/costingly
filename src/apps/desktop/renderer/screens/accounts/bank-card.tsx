/**
 * One bank on the Accounts screen: its name, how its syncing stands, and its
 * accounts as rows.
 *
 * Drawing only. Every string here arrives ready to show — the main process
 * has already worded the type, formatted the balance, and said what the last
 * sync did.
 *
 * A bank whose login has expired says so in its own box, with the button that
 * fixes it. That is a state the bank stays in until it is reconnected, which
 * is different from the result line beside it: that is only what the latest
 * sync did.
 */

import type { BankSyncResult, BankView } from "../../../bridge/contract.js";
import { Button } from "../../components/button.js";
import { StatusDot } from "../../components/status-dot.js";

export interface BankCardProps {
  bank: BankView;
  /** What the latest sync did for this bank, if there was one and it covered it. */
  result: BankSyncResult | undefined;
  onReconnect(bankId: string): void;
}

export function BankCard({ bank, result, onReconnect }: BankCardProps) {
  return (
    <section
      data-testid="bank"
      data-bank-name={bank.name}
      className="rounded-lg border border-slate-200 p-4 dark:border-slate-800"
    >
      <header className="mb-3">
        <div className="flex items-center gap-2">
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
        </div>
        {bank.lastSynced !== "" && (
          <p data-testid="bank-last-synced" className="mt-0.5 text-xs text-slate-600 dark:text-slate-300">
            {bank.lastSynced}
          </p>
        )}
        {result !== undefined && (
          <p
            data-testid="bank-sync-result"
            data-tone={result.tone}
            className="mt-1 flex items-center gap-2 text-sm"
          >
            <StatusDot tone={result.tone} />
            {result.text}
          </p>
        )}
      </header>

      {bank.needsAttention && (
        <div
          role="alert"
          data-testid="bank-needs-attention"
          className="mb-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
        >
          <p className="font-medium">Needs attention</p>
          <p className="mt-1">
            Your bank login has expired, so this bank is not being synced. Reconnecting keeps your
            accounts and history.
          </p>
          <Button
            variant="secondary"
            data-testid="bank-reconnect"
            onClick={() => onReconnect(bank.id)}
            className="mt-2"
          >
            Reconnect
          </Button>
        </div>
      )}

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
