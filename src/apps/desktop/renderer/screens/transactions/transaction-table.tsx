/**
 * The list of transactions: one row each, newest first.
 *
 * Drawing only. Every cell arrives ready to show — the main process chose the
 * description, worded the category, and put the sign on the amount.
 */

import type { TransactionRowView } from "../../../bridge/contract.js";

export function TransactionTable({ rows }: { rows: TransactionRowView[] }) {
  return (
    <table data-testid="transactions" className="w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-slate-200 text-left text-xs text-slate-600 dark:border-slate-800 dark:text-slate-300">
          <th scope="col" className="py-2 pr-4 font-medium whitespace-nowrap">
            Date
          </th>
          <th scope="col" className="py-2 pr-4 font-medium">
            Description
          </th>
          <th scope="col" className="py-2 pr-4 font-medium">
            Category
          </th>
          <th scope="col" className="py-2 pr-4 font-medium">
            Account
          </th>
          <th scope="col" className="py-2 text-right font-medium">
            Amount
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.id}
            data-testid="transaction"
            data-pending={row.pending ? "true" : "false"}
            data-money-in={row.moneyIn ? "true" : "false"}
            className="border-b border-slate-100 align-baseline dark:border-slate-900"
          >
            <td data-testid="transaction-date" className="py-2 pr-4 whitespace-nowrap">
              {row.date}
            </td>
            <td className="py-2 pr-4">
              <span data-testid="transaction-description">{row.description}</span>
              {row.pending && (
                <span
                  data-testid="transaction-pending"
                  className="ml-2 rounded bg-slate-200 px-1.5 py-0.5 text-xs dark:bg-slate-800"
                >
                  Pending
                </span>
              )}
            </td>
            <td data-testid="transaction-category" className="py-2 pr-4 text-slate-600 dark:text-slate-300">
              {row.category}
            </td>
            <td data-testid="transaction-account" className="py-2 pr-4 text-slate-600 dark:text-slate-300">
              {row.account}
            </td>
            <td
              data-testid="transaction-amount"
              className={
                "py-2 text-right whitespace-nowrap tabular-nums" +
                (row.moneyIn ? " text-emerald-700 dark:text-emerald-400" : "")
              }
            >
              {row.amount}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
