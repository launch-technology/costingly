/**
 * The shape of a generated dataset.
 *
 * Separate from the generator because these travel: the seed command reports on
 * a SeedDataset, and the writer consumes one, without either needing the 400
 * lines of invented merchants that produce it.
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

/** What a completed seed wrote. */
export interface SeedSummary {
  items: number;
  accounts: number;
  transactions: number;
  firstDate: string | null;
  lastDate: string | null;
}

/** The seeded random source every generator helper draws from. */
export interface Rng {
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
