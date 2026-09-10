/**
 * The invented world the generator draws from.
 *
 * Three institutions, four accounts, and the merchants behind every category of
 * spending — plus the subscriptions and utilities that recur monthly.
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
 * user actually returns, so queries written against this data meet the same mess
 * they will meet against a real bank. Data that is too clean teaches the wrong
 * lesson about what SQL will need to handle.
 *
 * NOT REAL BANKS
 *
 * Every institution name here is invented. Using "Chase" in a screenshot implies
 * a relationship costingly does not have.
 */

import type { Rng, SeedAccount, SeedItem } from "./seed.types.js";

// ---------------------------------------------------------------------------
// The institutions and accounts
// ---------------------------------------------------------------------------

export const ITEMS: SeedItem[] = [
  { itemId: "seed-item-northlake", institutionId: "seed_ins_001", institutionName: "Northlake Credit Union" },
  { itemId: "seed-item-cardinal", institutionId: "seed_ins_002", institutionName: "Cardinal Bank Card Services" },
  { itemId: "seed-item-vantage", institutionId: "seed_ins_003", institutionName: "Vantage One Financial" },
];

export const CHECKING = "seed-acct-checking";
export const SAVINGS = "seed-acct-savings";
export const CASH_CARD = "seed-acct-cash-card";
export const TRAVEL_CARD = "seed-acct-travel-card";

export const ACCOUNTS: Omit<SeedAccount, "currentBalance" | "availableBalance">[] = [
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

export const ITEM_OF: Record<string, string> = Object.fromEntries(
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

export interface MerchantSpec {
  merchant: string | null;
  describe: (rng: Rng) => string;
  pfcPrimary: string;
  pfcDetailed: string;
  channel: string;
  min: number;
  max: number;
}

export const GROCERIES: MerchantSpec[] = [
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

export const DINING: MerchantSpec[] = [
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

export const FUEL: MerchantSpec[] = [
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

export const SHOPPING: MerchantSpec[] = [
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

export const OUTINGS: MerchantSpec[] = [
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

export const TRAVEL: MerchantSpec[] = [
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
export interface SubscriptionSpec {
  name: string;
  merchant: string | null;
  amount: number;
  day: number;
  account: string;
  pfcPrimary: string;
  pfcDetailed: string;
}

export const SUBSCRIPTIONS: SubscriptionSpec[] = [
  { name: "Netflix", merchant: "Netflix", amount: 15.49, day: 4, account: CASH_CARD, pfcPrimary: "ENTERTAINMENT", pfcDetailed: "ENTERTAINMENT_TV_AND_MOVIES" },
  { name: "Spotify USA", merchant: "Spotify", amount: 11.99, day: 9, account: CASH_CARD, pfcPrimary: "ENTERTAINMENT", pfcDetailed: "ENTERTAINMENT_MUSIC_AND_AUDIO" },
  { name: "OPENAI *CHATGPT SUBSCR", merchant: null, amount: 20.0, day: 17, account: CASH_CARD, pfcPrimary: "GENERAL_SERVICES", pfcDetailed: "GENERAL_SERVICES_ONLINE_SUBSCRIPTIONS" },
  { name: "APPLE.COM/BILL", merchant: "Apple", amount: 9.99, day: 22, account: CASH_CARD, pfcPrimary: "GENERAL_SERVICES", pfcDetailed: "GENERAL_SERVICES_ONLINE_SUBSCRIPTIONS" },
  { name: "PLANET FIT CLUB FEES", merchant: "Planet Fitness", amount: 24.99, day: 12, account: CHECKING, pfcPrimary: "PERSONAL_CARE", pfcDetailed: "PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS" },
  { name: "DNH*GODADDY#3849271", merchant: "GoDaddy", amount: 21.99, day: 26, account: CASH_CARD, pfcPrimary: "GENERAL_SERVICES", pfcDetailed: "GENERAL_SERVICES_ONLINE_SUBSCRIPTIONS" },
];

/** Monthly bills whose amount moves with the season. */
export interface UtilitySpec {
  name: string;
  merchant: string | null;
  day: number;
  base: number;
  swing: number;
  /** Months (0-11) at the top of the swing. */
  peakMonths: number[];
  pfcDetailed: string;
}

export const UTILITIES: UtilitySpec[] = [
  { name: "DOMINION ENERGY WEB PMT", merchant: null, day: 14, base: 118, swing: 82, peakMonths: [0, 1, 6, 7], pfcDetailed: "RENT_AND_UTILITIES_GAS_AND_ELECTRICITY" },
  { name: "WASHINGTON GAS WEB PAY", merchant: null, day: 19, base: 44, swing: 61, peakMonths: [11, 0, 1, 2], pfcDetailed: "RENT_AND_UTILITIES_GAS_AND_ELECTRICITY" },
  { name: "VERIZON *RECURRING PMT", merchant: "Verizon", day: 8, base: 164, swing: 12, peakMonths: [], pfcDetailed: "RENT_AND_UTILITIES_TELEPHONE" },
  { name: "COX COMM WEB PMT", merchant: null, day: 21, base: 89, swing: 0, peakMonths: [], pfcDetailed: "RENT_AND_UTILITIES_INTERNET_AND_CABLE" },
];

export const RENT = 2185;
export const RENT_NAME = "NORTHLAKE PROPERTY MGMT RENT";
export const PAYCHECK_NET = 3420;
export const EMPLOYER = "MERIDIAN LABS PAYROLL DIR DEP";

