/**
 * How this install identifies itself to Plaid Link.
 *
 * Shared by both token flows — connecting a new bank and repairing an existing
 * one — which is the only reason these are not simply inline.
 */

import { CountryCode, Products } from "plaid";

/**
 * Only `transactions` is requested. That is what keeps this integration
 * read-only: no auth (account/routing numbers), no identity, no transfer.
 */
export const PRODUCTS: Products[] = [Products.Transactions];
export const COUNTRY_CODES: CountryCode[] = [CountryCode.Us];

/**
 * How much history to pull on the initial backfill.
 *
 * 730 days is the maximum Plaid will attempt; banks vary in how much they
 * actually hold. Because transactions are initialised at Link time, this has to
 * be set here — `/transactions/sync` cannot widen the window afterwards, and
 * the only way to change it later is to remove the Item and re-link.
 */
export const DAYS_REQUESTED = 730;

/**
 * Plaid wants a stable per-user id. This install serves exactly one person, so
 * it is a constant.
 */

/**
 * Plaid wants a stable per-user id. This install serves exactly one person, so
 * it is a constant.
 */
export const CLIENT_USER_ID = "local-user";
