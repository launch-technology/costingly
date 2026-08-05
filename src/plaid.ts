/**
 * Plaid SDK client and error helpers.
 *
 * Verified against the `plaid` npm package v45 (Plaid API version 2020-09-14).
 */

import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";
import type { PlaidError } from "plaid";
import { config } from "./config.js";

// Cached on globalThis for the same reason as the pg pool: warm serverless
// containers and Next.js hot reloads should not rebuild the client each time.
const globalForPlaid = globalThis as typeof globalThis & {
  __costinglyClient?: PlaidApi | undefined;
};

export function getPlaidClient(): PlaidApi {
  const existing = globalForPlaid.__costinglyClient;
  if (existing) return existing;

  const client = new PlaidApi(
    new Configuration({
      basePath: PlaidEnvironments[config.plaidEnv],
      baseOptions: {
        headers: {
          "PLAID-CLIENT-ID": config.plaidClientId,
          "PLAID-SECRET": config.plaidSecret,
          "Plaid-Version": "2020-09-14",
        },
      },
    }),
  );

  globalForPlaid.__costinglyClient = client;
  return client;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
// The SDK is axios-based, so a failed call throws an AxiosError whose
// `response.data` is Plaid's error body. We deliberately never log the error
// object itself: axios attaches the full request config to it, including the
// PLAID-SECRET header.

/** Extract Plaid's structured error body from a thrown SDK error, if present. */
export function getPlaidError(error: unknown): PlaidError | undefined {
  if (typeof error !== "object" || error === null) return undefined;

  const response = (error as { response?: unknown }).response;
  if (typeof response !== "object" || response === null) return undefined;

  const data = (response as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return undefined;

  if (typeof (data as { error_code?: unknown }).error_code !== "string") return undefined;

  return data as PlaidError;
}

/**
 * A safe, human-readable one-line description of any error.
 *
 * Never includes the axios error object, so it cannot leak credentials.
 */
export function describeError(error: unknown): string {
  const plaidError = getPlaidError(error);
  if (plaidError) {
    const suffix = plaidError.error_message ? `: ${plaidError.error_message}` : "";
    return `${plaidError.error_type}/${plaidError.error_code}${suffix}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

/** True if the error is the given Plaid `error_code`. */
export function isPlaidErrorCode(error: unknown, code: string): boolean {
  return getPlaidError(error)?.error_code === code;
}

/**
 * Plaid mutated the Item's transaction data while we were paginating through
 * /transactions/sync, invalidating the page cursors we were using.
 *
 * The documented recovery is to throw away everything accumulated so far and
 * restart pagination from the last cursor we have persisted.
 */
export function isMutationDuringPagination(error: unknown): boolean {
  return isPlaidErrorCode(error, "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION");
}

/**
 * The Item's credentials no longer work and the user must re-authenticate
 * through Link. Distinguishing this lets the sync mark the item rather than
 * retrying it fruitlessly every night.
 */
export function isItemLoginRequired(error: unknown): boolean {
  return isPlaidErrorCode(error, "ITEM_LOGIN_REQUIRED");
}
