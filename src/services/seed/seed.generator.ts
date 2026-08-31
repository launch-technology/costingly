/**
 * Fabricating a couple of years of plausible bank data.
 *
 * WHY THIS EXISTS
 *
 * Everything costingly does interestingly — charts, trends, "what did I spend on
 * groceries last year" — needs a couple of years of transactions. Getting those
 * from a real bank means showing someone's real money, and getting them from
 * Plaid's Sandbox means 30 days and 108 rows, which is what that environment
 * actually returns no matter what history you request.
 *
 * So this generates them. Nothing here talks to a network.
 *
 * DETERMINISM
 *
 * Same `seed` and same `endDate` produce byte-identical output, so a demo can be
 * re-recorded without the numbers moving. `endDate` defaults to today, since a
 * dataset whose most recent transaction is months old looks broken; pass it
 * explicitly when you need a take to match one from last week.
 *
 * What it draws from — the institutions, accounts and merchants — is in
 * seed.catalog.ts.
 */

import type {
  Rng,
  SeedAccount,
  SeedDataset,
  SeedItem,
  SeedOptions,
  SeedTransaction,
} from "./seed.types.js";
import {
  ACCOUNTS,
  CASH_CARD,
  CHECKING,
  DINING,
  EMPLOYER,
  FUEL,
  GROCERIES,
  ITEMS,
  ITEM_OF,
  OUTINGS,
  PAYCHECK_NET,
  RENT,
  RENT_NAME,
  SAVINGS,
  SHOPPING,
  SUBSCRIPTIONS,
  TRAVEL,
  TRAVEL_CARD,
  UTILITIES,
} from "./seed.catalog.js";
import type { MerchantSpec } from "./seed.catalog.js";

/**
 * mulberry32 — a small, fast, well-distributed PRNG.
 *
 * `Math.random()` cannot be used anywhere in this file: it would make the
 * dataset different on every run, which defeats re-recording a demo.
 */
function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}


function wrapRng(next: () => number): Rng {
  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const rng: Rng = {
    float: (min, max) => min + next() * (max - min),
    int: (min, max) => Math.floor(min + next() * (max - min + 1)),
    money: (min, max) => Math.round((min + next() * (max - min)) * 100) / 100,
    pick: (items) => items[Math.floor(next() * items.length)]!,
    chance: (p) => next() < p,
    digits: (length) =>
      Array.from({ length }, () => String(Math.floor(next() * 10))).join(""),
    code: (length) =>
      Array.from({ length }, () => ALPHABET[Math.floor(next() * ALPHABET.length)]).join(""),
  };
  return rng;
}

// ---------------------------------------------------------------------------
// Dates
//
// Plain calendar days throughout, formatted as YYYY-MM-DD and never turned back
// into a local-time Date. The column is DATE — a day, not an instant — and
// round-tripping through a local Date is how transactions end up a day early
// for anyone west of UTC.
// ---------------------------------------------------------------------------

const DAY_MS = 86_400_000;

function toDayNumber(iso: string): number {
  return Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY_MS);
}

function toIsoDate(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

function dayOfMonth(day: number): number {
  return new Date(day * DAY_MS).getUTCDate();
}

function monthKey(day: number): string {
  return toIsoDate(day).slice(0, 7);
}

/** "2026-01" -> "2025-12". */
function previousMonth(month: string): string {
  const year = Number(month.slice(0, 4));
  const index = Number(month.slice(5, 7));
  return index === 1
    ? `${year - 1}-12`
    : `${year}-${String(index - 1).padStart(2, "0")}`;
}

/** Today in UTC, as YYYY-MM-DD. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

export function generateSeedDataset(options: SeedOptions = {}): SeedDataset {
  const seed = options.seed ?? 20260101;
  const years = options.years ?? 2;
  const endIso = options.endDate ?? today();

  const rng = wrapRng(makeRng(seed));
  const lastDay = toDayNumber(endIso);
  const firstDay = lastDay - Math.round(years * 365);

  const transactions: SeedTransaction[] = [];
  let counter = 0;

  const add = (
    accountId: string,
    day: number,
    amount: number,
    name: string,
    merchantName: string | null,
    pfcPrimary: string,
    pfcDetailed: string,
    channel: string,
  ): void => {
    // A real feed has a few unsettled rows at the very end and nothing pending
    // further back. Anything else makes `WHERE pending = false` untestable.
    const pending = day > lastDay - 3 && rng.chance(0.45);
    transactions.push({
      transactionId: `seed-txn-${String(++counter).padStart(6, "0")}`,
      accountId,
      itemId: ITEM_OF[accountId]!,
      amount: Math.round(amount * 100) / 100,
      isoCurrencyCode: "USD",
      date: toIsoDate(day),
      authorizedDate: day > firstDay ? toIsoDate(day - rng.int(0, 2)) : null,
      name,
      merchantName,
      pending,
      paymentChannel: channel,
      pfcPrimary,
      pfcDetailed,
    });
  };

  const spend = (accountId: string, day: number, spec: MerchantSpec, scale = 1): void => {
    add(
      accountId,
      day,
      rng.money(spec.min, spec.max) * scale,
      spec.describe(rng),
      spec.merchant,
      spec.pfcPrimary,
      spec.pfcDetailed,
      spec.channel,
    );
  };

  // --- income: every other Friday -----------------------------------------
  // Walk back from the end so the most recent paycheck is always near "today",
  // which is what someone demoing "what did I earn this month" needs.
  for (let day = lastDay; day >= firstDay; day -= 14) {
    // Raises, so a year-over-year query has something to find.
    const yearsBack = (lastDay - day) / 365;
    const gross = PAYCHECK_NET * (1 - yearsBack * 0.045);
    add(CHECKING, day, -(gross + rng.float(-38, 38)), EMPLOYER, "Meridian Labs", "INCOME", "INCOME_WAGES", "other");
  }

  // --- annual bonus in February -------------------------------------------
  for (let day = firstDay; day <= lastDay; day++) {
    const date = toIsoDate(day);
    if (date.slice(5) === "02-14") {
      add(CHECKING, day, -rng.money(4200, 7400), `${EMPLOYER} BONUS`, "Meridian Labs", "INCOME", "INCOME_WAGES", "other");
    }
  }

  // --- monthly fixtures ----------------------------------------------------
  const months = new Set<string>();
  for (let day = firstDay; day <= lastDay; day++) months.add(monthKey(day));

  const dayIn = (month: string, dom: number): number | null => {
    const day = toDayNumber(`${month}-${String(dom).padStart(2, "0")}`);
    return day >= firstDay && day <= lastDay ? day : null;
  };

  for (const month of months) {
    const monthIndex = Number(month.slice(5, 7)) - 1;
    const on = (dom: number): number | null => dayIn(month, dom);

    const rentDay = on(1);
    if (rentDay !== null) {
      add(CHECKING, rentDay, RENT, RENT_NAME, null, "RENT_AND_UTILITIES", "RENT_AND_UTILITIES_RENT", "other");
    }

    for (const utility of UTILITIES) {
      const day = on(utility.day);
      if (day === null) continue;
      const peak = utility.peakMonths.includes(monthIndex);
      const amount = utility.base + (peak ? utility.swing : 0) * rng.float(0.6, 1) + rng.float(-9, 9);
      add(CHECKING, day, amount, utility.name, utility.merchant, "RENT_AND_UTILITIES", utility.pfcDetailed, "other");
    }

    for (const sub of SUBSCRIPTIONS) {
      const day = on(sub.day);
      if (day === null) continue;
      add(sub.account, day, sub.amount, sub.name, sub.merchant, sub.pfcPrimary, sub.pfcDetailed, "online");
    }

    // Savings transfer — out of checking, into savings. Two rows, because that
    // is what a bank reports, and a naive SUM over everything should visibly
    // net to zero rather than silently double-count.
    const transferDay = on(3);
    if (transferDay !== null) {
      const amount = rng.money(400, 900);
      add(CHECKING, transferDay, amount, "ONLINE TRANSFER TO SAV *8820", null, "TRANSFER_OUT", "TRANSFER_OUT_ACCOUNT_TRANSFER", "other");
      add(SAVINGS, transferDay, -amount, "ONLINE TRANSFER FROM CHK *4471", null, "TRANSFER_IN", "TRANSFER_IN_ACCOUNT_TRANSFER", "other");
    }

    const interestDay = on(28);
    if (interestDay !== null) {
      add(SAVINGS, interestDay, -rng.money(9, 34), "INTEREST PAYMENT", null, "INCOME", "INCOME_INTEREST_EARNED", "other");
    }
  }

  // --- everyday spending ---------------------------------------------------
  for (let day = firstDay; day <= lastDay; day++) {
    const weekday = (day % 7 + 7) % 7; // 0 = Thursday, given the epoch
    const isWeekend = weekday === 3 || weekday === 4;

    if (rng.chance(0.34)) spend(rng.chance(0.7) ? CASH_CARD : CHECKING, day, rng.pick(GROCERIES));
    if (rng.chance(isWeekend ? 0.72 : 0.44)) spend(CASH_CARD, day, rng.pick(DINING));
    if (rng.chance(isWeekend ? 0.3 : 0.16)) spend(CASH_CARD, day, rng.pick(DINING));
    if (rng.chance(0.16)) spend(rng.chance(0.5) ? CASH_CARD : TRAVEL_CARD, day, rng.pick(FUEL));
    if (rng.chance(0.29)) spend(CASH_CARD, day, rng.pick(SHOPPING));
    if (rng.chance(isWeekend ? 0.22 : 0.08)) spend(CASH_CARD, day, rng.pick(OUTINGS));

    // Holiday spending, so December stands out from November.
    if (toIsoDate(day).slice(5, 7) === "12" && dayOfMonth(day) <= 22 && rng.chance(0.42)) {
      spend(CASH_CARD, day, rng.pick(SHOPPING), 1.6);
    }
  }

  // --- travel, in bursts ---------------------------------------------------
  // Trips, not scattered flights: a booking, then hotel and car within a few
  // days, all on the travel card. Scattering them would flatten exactly the
  // pattern a "when did I travel" question is looking for.
  for (let day = firstDay + 40; day <= lastDay - 10; day += rng.int(95, 160)) {
    spend(TRAVEL_CARD, day, TRAVEL[0]!);
    spend(TRAVEL_CARD, day + rng.int(20, 60), TRAVEL[1]!);
    if (rng.chance(0.6)) spend(TRAVEL_CARD, day + rng.int(20, 60), TRAVEL[2]!);
  }

  // --- credit card payments ------------------------------------------------
  // Sized to what the card was actually charged the month before, the way
  // someone paying their statement in full would. This has to run after all the
  // card spending exists, which is why it is not in the monthly loop above.
  //
  // A fixed or random payment was the first thing tried, and it is wrong in a
  // way that only shows up at the end: over two years the balance drifts to
  // whatever the gap between charges and payments compounds to, and the account
  // ends up owing a number no real card would show.
  for (const [card, mask, dom] of [
    [CASH_CARD, "3092", 16],
    [TRAVEL_CARD, "7715", 23],
  ] as const) {
    const chargedIn = new Map<string, number>();
    for (const txn of transactions) {
      if (txn.accountId !== card || txn.amount <= 0) continue;
      const key = txn.date.slice(0, 7);
      chargedIn.set(key, (chargedIn.get(key) ?? 0) + txn.amount);
    }

    for (const month of months) {
      const day = dayIn(month, dom);
      if (day === null) continue;
      const owed = chargedIn.get(previousMonth(month)) ?? 0;
      if (owed < 1) continue;
      add(CHECKING, day, owed, `ONLINE PAYMENT TO CARD *${mask}`, null, "TRANSFER_OUT", "TRANSFER_OUT_ACCOUNT_TRANSFER", "other");
      add(card, day, -owed, "PAYMENT THANK YOU - WEB", null, "TRANSFER_IN", "TRANSFER_IN_ACCOUNT_TRANSFER", "other");
    }
  }

  transactions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // --- balances ------------------------------------------------------------
  const accounts: SeedAccount[] = ACCOUNTS.map((account) => {
    if (account.type === "credit") {
      // What is owed: everything charged since the last payment on that card.
      // Derivable from the rows above, so the balance agrees with the ledger
      // instead of being a number someone typed.
      const rows = transactions.filter((t) => t.accountId === account.accountId);
      const lastPayment = rows.findLastIndex((t) => t.pfcPrimary === "TRANSFER_IN");
      const owed = rows
        .slice(lastPayment + 1)
        .reduce((total, t) => total + t.amount, 0);
      return {
        ...account,
        currentBalance: Math.round(owed * 100) / 100,
        availableBalance: Math.round((9000 - owed) * 100) / 100,
      };
    }

    const balance = account.accountId === CHECKING ? 7842.16 : 21460.88;
    return { ...account, currentBalance: balance, availableBalance: balance };
  });

  return { items: ITEMS, accounts, transactions };
}

