/**
 * Fabricated bank data for demos and development.
 *
 * WHY THIS EXISTS
 *
 * Everything costingly does interestingly — charts, trends, "what did I spend
 * on groceries last year" — needs a couple of years of plausible transactions.
 * Getting those from a real bank means showing someone's real money, and
 * getting them from Plaid's Sandbox means 30 days and 108 rows, which is what
 * that environment actually returns no matter what history you request.
 *
 * So this generates them. Nothing here talks to a network.
 *
 * WHAT MAKES IT LOOK REAL
 *
 * The descriptions. Real bank feeds are not tidy merchant names — they are a
 * mix of clean strings and raw terminal noise, and the raw kind is most of it:
 *
 *     TST*TACO ROCK - LORTON
 *     AMAZON MKTPL*BD4XZ9GIX
 *     PURCHASE AUTHORIZED ON 05/27 ROYAL FARMS 100 MONUMENT AVE NATIONAL HARBOR MD
 *
 * Those shapes were taken from what Plaid's `user_transactions_dynamic` Sandbox
 * user actually returns, so queries written against this data meet the same
 * mess they will meet against a real bank — which is the point. Data that is
 * too clean teaches the wrong lesson about what SQL will need to handle.
 *
 * DETERMINISM
 *
 * Same `seed` and same `endDate` produce byte-identical output, so a demo can
 * be re-recorded without the numbers moving. `endDate` defaults to today, since
 * a dataset whose most recent transaction is months old looks broken; pass it
 * explicitly when you need a take to match one from last week.
 *
 * NOT REAL BANKS
 *
 * Every institution name here is invented. Using "Chase" in a screenshot
 * implies a relationship costingly does not have.
 */

/** Positive is money OUT, negative is money IN — the schema's convention. */
export interface SeedTransaction {
  transactionId: string;
  accountId: string;
  itemId: string;
  amount: number;
  isoCurrencyCode: string;
  date: string;
  authorizedDate: string | null;
  name: string;
  merchantName: string | null;
  pending: boolean;
  paymentChannel: string;
  pfcPrimary: string;
  pfcDetailed: string;
}

export interface SeedAccount {
  accountId: string;
  itemId: string;
  name: string;
  officialName: string | null;
  mask: string;
  type: string;
  subtype: string;
  currency: string;
  currentBalance: number;
  availableBalance: number | null;
}

export interface SeedItem {
  itemId: string;
  institutionId: string;
  institutionName: string;
}

export interface SeedDataset {
  items: SeedItem[];
  accounts: SeedAccount[];
  transactions: SeedTransaction[];
}

export interface SeedOptions {
  /** Any integer. The same one always produces the same dataset. */
  seed?: number;
  /** Years of history to generate. */
  years?: number;
  /** Last day covered, `YYYY-MM-DD`. Defaults to today. */
  endDate?: string;
}

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

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

interface Rng {
  /** Uniform float in [min, max). */
  float(min: number, max: number): number;
  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number;
  /** Money in [min, max], two decimals. */
  money(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  /** True with probability p. */
  chance(p: number): boolean;
  /** A run of `length` digits, as a string. */
  digits(length: number): string;
  /** A run of `length` uppercase letters and digits. */
  code(length: number): string;
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
// The institutions and accounts
// ---------------------------------------------------------------------------

const ITEMS: SeedItem[] = [
  { itemId: "seed-item-northlake", institutionId: "seed_ins_001", institutionName: "Northlake Credit Union" },
  { itemId: "seed-item-cardinal", institutionId: "seed_ins_002", institutionName: "Cardinal Bank Card Services" },
  { itemId: "seed-item-vantage", institutionId: "seed_ins_003", institutionName: "Vantage One Financial" },
];

const CHECKING = "seed-acct-checking";
const SAVINGS = "seed-acct-savings";
const CASH_CARD = "seed-acct-cash-card";
const TRAVEL_CARD = "seed-acct-travel-card";

const ACCOUNTS: Omit<SeedAccount, "currentBalance" | "availableBalance">[] = [
  {
    accountId: CHECKING,
    itemId: "seed-item-northlake",
    name: "Everyday Checking",
    officialName: "Northlake Everyday Checking",
    mask: "4471",
    type: "depository",
    subtype: "checking",
    currency: "USD",
  },
  {
    accountId: SAVINGS,
    itemId: "seed-item-northlake",
    name: "Rainy Day Savings",
    officialName: "Northlake High-Yield Savings",
    mask: "8820",
    type: "depository",
    subtype: "savings",
    currency: "USD",
  },
  {
    accountId: CASH_CARD,
    itemId: "seed-item-cardinal",
    name: "Cash Rewards Card",
    officialName: "Cardinal Cash Rewards Visa Signature",
    mask: "3092",
    type: "credit",
    subtype: "credit card",
    currency: "USD",
  },
  {
    accountId: TRAVEL_CARD,
    itemId: "seed-item-vantage",
    name: "Travel Signature Card",
    officialName: "Vantage One Travel Signature Mastercard",
    mask: "7715",
    type: "credit",
    subtype: "credit card",
    currency: "USD",
  },
];

const ITEM_OF: Record<string, string> = Object.fromEntries(
  ACCOUNTS.map((account) => [account.accountId, account.itemId]),
);

// ---------------------------------------------------------------------------
// Merchants
//
// `describe` builds the raw bank string; `merchant` is the cleaned name Plaid
// would attach, or null where a real feed would not resolve one. The split
// matters: v_transactions exposes both, and a query that only ever reads
// merchant_name silently drops the messy rows — which is exactly the mistake
// this data should let someone make and then notice.
// ---------------------------------------------------------------------------

interface MerchantSpec {
  merchant: string | null;
  describe: (rng: Rng) => string;
  pfcPrimary: string;
  pfcDetailed: string;
  channel: string;
  min: number;
  max: number;
}

const GROCERIES: MerchantSpec[] = [
  {
    merchant: "Wegmans",
    describe: (r) => `WEGMANS #${r.int(10, 99)} FAIRFAX VA`,
    pfcPrimary: "FOOD_AND_DRINK",
    pfcDetailed: "FOOD_AND_DRINK_GROCERIES",
    channel: "in store",
    min: 48,
    max: 214,
  },
  {
    merchant: "Safeway",
    describe: (r) => `SAFEWAY #${r.int(1000, 1999)} PURCHASE ${r.digits(6)}`,
    pfcPrimary: "FOOD_AND_DRINK",
    pfcDetailed: "FOOD_AND_DRINK_GROCERIES",
    channel: "in store",
    min: 32,
    max: 156,
  },
  {
    merchant: "Trader Joe's",
    describe: () => `TRADER JOE'S #648 QPS`,
    pfcPrimary: "FOOD_AND_DRINK",
    pfcDetailed: "FOOD_AND_DRINK_GROCERIES",
    channel: "in store",
    min: 26,
    max: 118,
  },
  {
    merchant: null,
    describe: (r) =>
      `PURCHASE AUTHORIZED ON ${r.int(1, 12)}/${r.int(10, 28)} LIDL #${r.digits(4)} ` +
      `ALEXANDRIA VA ${r.digits(13)} CARD ${r.digits(4)}`,
    pfcPrimary: "FOOD_AND_DRINK",
    pfcDetailed: "FOOD_AND_DRINK_GROCERIES",
    channel: "in store",
    min: 22,
    max: 97,
  },
  {
    merchant: "Costco",
    describe: (r) => `COSTCO WHSE #${r.int(100, 999)}`,
    pfcPrimary: "FOOD_AND_DRINK",
    pfcDetailed: "FOOD_AND_DRINK_GROCERIES",
    channel: "in store",
    min: 84,
    max: 341,
  },
];

const DINING: MerchantSpec[] = [
  {
    merchant: null,
    describe: (r) => `TST*${r.pick(["TACO ROCK", "AMBAR", "CAVA", "GYRO FACTORY", "THE PIZZA PLACE"])} - ${r.pick(["LORTON", "CLARENDON", "KINGSTOWNE", "WOODBRIDGE"])}`,
    pfcPrimary: "FOOD_AND_DRINK",
    pfcDetailed: "FOOD_AND_DRINK_RESTAURANT",
    channel: "in store",
    min: 14,
    max: 96,
  },
  {
    merchant: "Starbucks",
    describe: () => "Starbucks",
    pfcPrimary: "FOOD_AND_DRINK",
    pfcDetailed: "FOOD_AND_DRINK_COFFEE",
    channel: "in store",
    min: 4.25,
    max: 18.4,
  },
  {
    merchant: "Chipotle",
    describe: (r) => `CHIPOTLE ${r.digits(4)}`,
    pfcPrimary: "FOOD_AND_DRINK",
    pfcDetailed: "FOOD_AND_DRINK_FAST_FOOD",
    channel: "in store",
    min: 11.5,
    max: 42,
  },
  {
    merchant: "DoorDash",
    describe: (r) => `DD *DOORDASH ${r.pick(["THAIRESTAU", "SWEETGREEN", "PANERABREAD", "SHAKESHACK"])}`,
    pfcPrimary: "FOOD_AND_DRINK",
    pfcDetailed: "FOOD_AND_DRINK_RESTAURANT",
    channel: "online",
    min: 18,
    max: 74,
  },
  {
    merchant: null,
    describe: (r) => `SQ *${r.pick(["BLUE BOTTLE COFFEE", "COMPASS COFFEE", "BAKED & WIRED"])}`,
    pfcPrimary: "FOOD_AND_DRINK",
    pfcDetailed: "FOOD_AND_DRINK_COFFEE",
    channel: "in store",
    min: 5.75,
    max: 27,
  },
  {
    merchant: null,
    describe: (r) => `QUEENS BAR ${r.int(10, 99)} E GRAND RIVER AVE DETROIT MI CARD ${r.digits(4)}`,
    pfcPrimary: "FOOD_AND_DRINK",
    pfcDetailed: "FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR",
    channel: "in store",
    min: 22,
    max: 118,
  },
];

const FUEL: MerchantSpec[] = [
  {
    merchant: "ExxonMobil",
    describe: (r) => `EXXONMOBIL ${r.digits(8)}`,
    pfcPrimary: "TRANSPORTATION",
    pfcDetailed: "TRANSPORTATION_GAS",
    channel: "in store",
    min: 32,
    max: 88,
  },
  {
    merchant: null,
    describe: (r) => `SHELL OIL ${r.digits(11)}`,
    pfcPrimary: "TRANSPORTATION",
    pfcDetailed: "TRANSPORTATION_GAS",
    channel: "in store",
    min: 28,
    max: 79,
  },
  {
    merchant: null,
    describe: (r) => `WAWA ${r.digits(4)} PURCHASE ${r.digits(6)}`,
    pfcPrimary: "TRANSPORTATION",
    pfcDetailed: "TRANSPORTATION_GAS",
    channel: "in store",
    min: 24,
    max: 71,
  },
];

const SHOPPING: MerchantSpec[] = [
  {
    merchant: "Amazon",
    describe: (r) => `AMAZON MKTPL*${r.code(9)}`,
    pfcPrimary: "GENERAL_MERCHANDISE",
    pfcDetailed: "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES",
    channel: "online",
    min: 8.5,
    max: 187,
  },
  {
    merchant: "Amazon",
    describe: (r) => `Amazon.com*${r.code(9)}`,
    pfcPrimary: "GENERAL_MERCHANDISE",
    pfcDetailed: "GENERAL_MERCHANDISE_ONLINE_MARKETPLACES",
    channel: "online",
    min: 11,
    max: 241,
  },
  {
    merchant: "Target",
    describe: (r) => `TARGET #${r.digits(5)} ALEXANDRIA VA`,
    pfcPrimary: "GENERAL_MERCHANDISE",
    pfcDetailed: "GENERAL_MERCHANDISE_SUPERSTORES",
    channel: "in store",
    min: 18,
    max: 214,
  },
  {
    // Small amounts on purpose: this household pays rent. A renter running
    // $7k a year through a hardware store is the kind of detail that makes a
    // demo dataset feel assembled rather than observed.
    merchant: "Home Depot",
    describe: (r) => `THE HOME DEPOT ${r.digits(4)}`,
    pfcPrimary: "HOME_IMPROVEMENT",
    pfcDetailed: "HOME_IMPROVEMENT_HARDWARE",
    channel: "in store",
    min: 9,
    max: 96,
  },
  {
    merchant: "CVS",
    describe: (r) => `CVS/PHARMACY #${r.digits(5)}`,
    pfcPrimary: "PERSONAL_CARE",
    pfcDetailed: "PERSONAL_CARE_PHARMACIES_AND_SUPPLEMENTS",
    channel: "in store",
    min: 6.25,
    max: 94,
  },
];

const OUTINGS: MerchantSpec[] = [
  {
    merchant: null,
    describe: (r) => `AMC ONLINE ${r.digits(6)}`,
    pfcPrimary: "ENTERTAINMENT",
    pfcDetailed: "ENTERTAINMENT_MOVIES_AND_DVDS",
    channel: "online",
    min: 24,
    max: 78,
  },
  {
    merchant: null,
    describe: () => "STEAMGAMES.COM 4259522985",
    pfcPrimary: "ENTERTAINMENT",
    pfcDetailed: "ENTERTAINMENT_VIDEO_GAMES",
    channel: "online",
    min: 9.99,
    max: 69.99,
  },
  {
    merchant: "Uber",
    describe: (r) => `UBER *TRIP ${r.digits(9)}`,
    pfcPrimary: "TRANSPORTATION",
    pfcDetailed: "TRANSPORTATION_TAXIS_AND_RIDE_SHARES",
    channel: "online",
    min: 11,
    max: 68,
  },
  {
    merchant: null,
    describe: (r) => `INOVA HC SVCS-MYCHART ${r.digits(6)}`,
    pfcPrimary: "MEDICAL",
    pfcDetailed: "MEDICAL_PRIMARY_CARE",
    channel: "online",
    min: 25,
    max: 340,
  },
];

const TRAVEL: MerchantSpec[] = [
  {
    merchant: "Delta Air Lines",
    describe: (r) => `DELTA AIR LINES ${r.digits(13)}`,
    pfcPrimary: "TRAVEL",
    pfcDetailed: "TRAVEL_FLIGHTS",
    channel: "online",
    min: 186,
    max: 1240,
  },
  {
    merchant: "Marriott",
    describe: (r) => `MARRIOTT HOTELS ${r.digits(6)} CHARLESTON SC`,
    pfcPrimary: "TRAVEL",
    pfcDetailed: "TRAVEL_LODGING",
    channel: "online",
    min: 214,
    max: 890,
  },
  {
    merchant: null,
    describe: (r) => `HERTZ RENT-A-CAR ${r.digits(8)}`,
    pfcPrimary: "TRAVEL",
    pfcDetailed: "TRAVEL_RENTAL_CARS",
    channel: "online",
    min: 148,
    max: 512,
  },
];

/** Fixed monthly charges: same merchant, same day, near-identical amount. */
interface SubscriptionSpec {
  name: string;
  merchant: string | null;
  amount: number;
  day: number;
  account: string;
  pfcPrimary: string;
  pfcDetailed: string;
}

const SUBSCRIPTIONS: SubscriptionSpec[] = [
  { name: "Netflix", merchant: "Netflix", amount: 15.49, day: 4, account: CASH_CARD, pfcPrimary: "ENTERTAINMENT", pfcDetailed: "ENTERTAINMENT_TV_AND_MOVIES" },
  { name: "Spotify USA", merchant: "Spotify", amount: 11.99, day: 9, account: CASH_CARD, pfcPrimary: "ENTERTAINMENT", pfcDetailed: "ENTERTAINMENT_MUSIC_AND_AUDIO" },
  { name: "OPENAI *CHATGPT SUBSCR", merchant: null, amount: 20.0, day: 17, account: CASH_CARD, pfcPrimary: "GENERAL_SERVICES", pfcDetailed: "GENERAL_SERVICES_ONLINE_SUBSCRIPTIONS" },
  { name: "APPLE.COM/BILL", merchant: "Apple", amount: 9.99, day: 22, account: CASH_CARD, pfcPrimary: "GENERAL_SERVICES", pfcDetailed: "GENERAL_SERVICES_ONLINE_SUBSCRIPTIONS" },
  { name: "PLANET FIT CLUB FEES", merchant: "Planet Fitness", amount: 24.99, day: 12, account: CHECKING, pfcPrimary: "PERSONAL_CARE", pfcDetailed: "PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS" },
  { name: "DNH*GODADDY#3849271", merchant: "GoDaddy", amount: 21.99, day: 26, account: CASH_CARD, pfcPrimary: "GENERAL_SERVICES", pfcDetailed: "GENERAL_SERVICES_ONLINE_SUBSCRIPTIONS" },
];

/** Monthly bills whose amount moves with the season. */
interface UtilitySpec {
  name: string;
  merchant: string | null;
  day: number;
  base: number;
  swing: number;
  /** Months (0-11) at the top of the swing. */
  peakMonths: number[];
  pfcDetailed: string;
}

const UTILITIES: UtilitySpec[] = [
  { name: "DOMINION ENERGY WEB PMT", merchant: null, day: 14, base: 118, swing: 82, peakMonths: [0, 1, 6, 7], pfcDetailed: "RENT_AND_UTILITIES_GAS_AND_ELECTRICITY" },
  { name: "WASHINGTON GAS WEB PAY", merchant: null, day: 19, base: 44, swing: 61, peakMonths: [11, 0, 1, 2], pfcDetailed: "RENT_AND_UTILITIES_GAS_AND_ELECTRICITY" },
  { name: "VERIZON *RECURRING PMT", merchant: "Verizon", day: 8, base: 164, swing: 12, peakMonths: [], pfcDetailed: "RENT_AND_UTILITIES_TELEPHONE" },
  { name: "COX COMM WEB PMT", merchant: null, day: 21, base: 89, swing: 0, peakMonths: [], pfcDetailed: "RENT_AND_UTILITIES_INTERNET_AND_CABLE" },
];

const RENT = 2185;
const RENT_NAME = "NORTHLAKE PROPERTY MGMT RENT";
const PAYCHECK_NET = 3420;
const EMPLOYER = "MERIDIAN LABS PAYROLL DIR DEP";

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
