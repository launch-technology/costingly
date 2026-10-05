/**
 * A small, fixed set of banks, accounts and transactions for the suites that
 * read transactions.
 *
 * Not a suite — the runner only picks up `*.test.mts`.
 *
 * WRITTEN OUT, NOT GENERATED. The suites that use this assert exact counts,
 * exact days and exact rows, so every awkward case has to be here by
 * construction rather than by luck: a pending row, money coming in, a
 * description with a % in it, a transaction with no category, an account
 * with more than two hundred rows, and one with five.
 *
 * NOTHING HERE IMPORTS FROM src/ at runtime. A suite sets COSTINGLY_HOME
 * before importing the source tree, and a helper that imported it first would
 * resolve the real profile. This builds plain rows; the suite saves them with
 * the repositories it has already imported, through `saveFixture`.
 */

import type { AccountRow } from "../src/domain/data/repositories/accounts.repository.js";
import type { SaveItemParams } from "../src/domain/data/repositories/items.repository.js";
import type { TransactionRow } from "../src/domain/data/repositories/transactions.repository.js";

export const MAPLE = "fx-maple";
export const OAK = "fx-oak";
export const CHECKING = "fx-checking";
export const CARD = "fx-card";
export const SAVINGS = "fx-savings";

/** The day `offset` days after 1 January 2026, as "YYYY-MM-DD". */
const day = (offset: number): string => new Date(Date.UTC(2026, 0, 1 + offset)).toISOString().slice(0, 10);

function transaction(
  id: string,
  accountId: string,
  itemId: string,
  change: Partial<TransactionRow> & Pick<TransactionRow, "date" | "name" | "amount">,
): TransactionRow {
  return {
    transactionId: id,
    accountId,
    itemId,
    isoCurrencyCode: "USD",
    authorizedDate: null,
    merchantName: null,
    pending: false,
    paymentChannel: null,
    category: null,
    pfc: JSON.stringify({ primary: "GENERAL_MERCHANDISE" }),
    raw: "{}",
    ...change,
  };
}

export interface Fixture {
  items: SaveItemParams[];
  accounts: AccountRow[];
  transactions: TransactionRow[];
}

/** How many transactions each account holds, and the facts the suites assert against. */
export const FACTS = {
  checking: 230,
  card: 20,
  savings: 5,
  total: 255,
  /** The newest transaction of all: the pending one on the card. */
  newestDay: day(231),
  /** The checking account's newest. */
  checkingNewestDay: day(229),
  /** A day with exactly one checking transaction and nothing else. */
  quietDay: day(40),
  /** Checking rows whose merchant name is "Corner Coffee": the even ones. */
  cornerCoffee: 115,
} as const;

export function buildFixture(): Fixture {
  const items: SaveItemParams[] = [
    { itemId: MAPLE, institutionId: null, institutionName: "Maple Bank", source: "plaid", accessToken: "access-fixture-maple" },
    { itemId: OAK, institutionId: null, institutionName: "Oak Credit Union", source: "plaid", accessToken: "access-fixture-oak" },
  ];

  const account = (accountId: string, itemId: string, name: string, mask: string, type: string, subtype: string): AccountRow => ({
    accountId,
    itemId,
    name,
    officialName: null,
    mask,
    type,
    subtype,
    currency: "USD",
    currentBalance: 1000,
    availableBalance: null,
  });
  const accounts: AccountRow[] = [
    account(CHECKING, MAPLE, "Everyday Checking", "1111", "depository", "checking"),
    account(CARD, MAPLE, "Rewards Card", "2222", "credit", "credit card"),
    account(SAVINGS, OAK, "Rainy Day", "3333", "depository", "savings"),
  ];

  const transactions: TransactionRow[] = [];

  // Checking: one a day for 230 days. Even ones carry a tidy merchant name;
  // odd ones only the bank's own text.
  for (let i = 0; i < FACTS.checking; i++) {
    transactions.push(
      transaction(`fx-chk-${String(i).padStart(3, "0")}`, CHECKING, MAPLE, {
        date: day(i),
        name: `POS DEBIT COFFEE SHOP #${i}`,
        merchantName: i % 2 === 0 ? "Corner Coffee" : null,
        amount: 4.5,
        pfc: JSON.stringify({ primary: "FOOD_AND_DRINK" }),
      }),
    );
  }

  // The card: twenty rows over the last twenty days, with the search edge
  // cases and the one pending transaction among them.
  for (let i = 0; i < FACTS.card; i++) {
    const special: Partial<TransactionRow> & { name: string } =
      i === 3
        ? { name: "50% OFF OUTLET" }
        : i === 4
          ? { name: "SAVE_MORE MART" }
          : i === 5
            ? { name: "SAVEXMORE MART" }
            : i === 19
              ? { name: "PENDING PIZZA ORDER", merchantName: "Pizza Place", pending: true }
              : { name: "TST* PIZZA PLACE", merchantName: "Pizza Place" };
    transactions.push(
      transaction(`fx-card-${String(i).padStart(2, "0")}`, CARD, MAPLE, {
        date: day(212 + i),
        amount: 20 + i,
        ...special,
      }),
    );
  }

  // Savings: money IN, which is stored as a negative amount. One row has no
  // category at all.
  for (let i = 0; i < FACTS.savings; i++) {
    transactions.push(
      transaction(`fx-sav-${i}`, SAVINGS, OAK, {
        date: day(73 + i * 31),
        name: "PAYROLL DEPOSIT",
        merchantName: null,
        amount: -2500,
        pfc: i === 0 ? null : JSON.stringify({ primary: "INCOME" }),
      }),
    );
  }

  return { items, accounts, transactions };
}

/** The three repository functions a suite hands over, already imported after COSTINGLY_HOME was set. */
export interface FixtureWriters {
  saveItem(params: SaveItemParams): Promise<void>;
  saveAccounts(rows: readonly AccountRow[]): Promise<unknown>;
  saveTransactions(rows: readonly TransactionRow[]): Promise<void>;
}

export async function saveFixture(writers: FixtureWriters): Promise<Fixture> {
  const fixture = buildFixture();
  for (const item of fixture.items) await writers.saveItem(item);
  await writers.saveAccounts(fixture.accounts);
  await writers.saveTransactions(fixture.transactions);
  return fixture;
}
