/**
 * Plaid's shapes, flattened into the rows the repositories store.
 *
 * This is the one place Plaid field names are translated. The repositories know
 * about columns and nothing about providers; the services know about Plaid and
 * nothing about SQL. Everything that has to understand both lives here.
 */

import type { AccountBase, Transaction } from "plaid";
import type { TransactionRow } from "../../data/repositories/transactions.repository.js";
import type { AccountRow } from "../../data/repositories/accounts.repository.js";

/**
 * Plaid's transaction shape, flattened into the row the repository stores.
 *
 * Plaid field names are this service's business, not the repository's — which is
 * why the mapping lives here and the SQL does not.
 */
export function toTransactionRow(transaction: Transaction, itemId: string): TransactionRow {
  return {
    transactionId: transaction.transaction_id,
    accountId: transaction.account_id,
    itemId,
    // Plaid's sign convention is preserved verbatim:
    // positive = money out, negative = money in. See schema.sql.
    amount: transaction.amount,
    isoCurrencyCode: transaction.iso_currency_code ?? transaction.unofficial_currency_code ?? null,
    date: transaction.date,
    authorizedDate: transaction.authorized_date ?? null,
    name: transaction.name,
    merchantName: transaction.merchant_name ?? null,
    pending: transaction.pending,
    paymentChannel: transaction.payment_channel,
    // `category` is a string array. node-postgres would encode a raw JS array as
    // a Postgres array literal, not as JSON, so it must be stringified.
    category: transaction.category ? JSON.stringify(transaction.category) : null,
    pfc: transaction.personal_finance_category
      ? JSON.stringify(transaction.personal_finance_category)
      : null,
    raw: JSON.stringify(transaction),
  };
}


/** One account from /accounts/get or a sync response. */
export function toAccountRow(account: AccountBase, itemId: string): AccountRow {
  const { balances } = account;
  return {
    accountId: account.account_id,
    itemId,
    name: account.name,
    officialName: account.official_name ?? null,
    mask: account.mask ?? null,
    type: account.type,
    subtype: account.subtype ?? null,
    currency: balances.iso_currency_code ?? balances.unofficial_currency_code ?? null,
    currentBalance: balances.current ?? null,
    availableBalance: balances.available ?? null,
  };
}
