/**
 * Costingly's Plaid client, and the helpers for reading Plaid's errors.
 *
 * A `PlaidClient` is HANDED to whatever needs Plaid — a service, the sync
 * pipeline's source, the link server. Nothing reaches for one. That is what
 * lets the same code run against different Plaids without knowing it:
 *
 *   the product      one client, built in default-plaid.ts from the profile's
 *                    keys. Production, always.
 *   trying new keys  a throwaway client built from the pair being offered.
 *   the test suites  a client built in sandbox mode from test-only keys, and
 *                    passed to the code under test.
 *
 * THERE IS NO SETTING THAT CHOOSES THE SERVER. There used to be — a
 * `PLAID_ENV` variable and a `plaidEnv` config key — and it meant an install
 * could be pointed at Plaid's sandbox by accident, or believed to be when it
 * was not. Which Plaid a client talks to is now decided by whoever constructs
 * it, in code, and the only code that says "sandbox" is under tests/.
 *
 * Verified against the `plaid` npm package v45 (Plaid API version 2020-09-14).
 */

import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";
import type { PlaidError } from "plaid";

/** A Plaid client ID and secret: one pair, for one Plaid server. */
export interface PlaidCredentials {
  clientId: string;
  secret: string;
}

/**
 * Which Plaid a client talks to. Real banks, or Plaid's fake ones.
 *
 * `sandbox` exists for the test suites, which need a Plaid that will link a
 * bank with no person in a browser. Nothing in src/ constructs a sandbox client.
 */
export type PlaidServer = "production" | "sandbox";

export interface PlaidClientOptions {
  /**
   * The keys to use, asked for whenever a call is about to be made.
   *
   * A function rather than a value because keys arrive late and change: a
   * desktop app starts before setup has saved any, and settings can replace
   * them while it runs. May throw when there are none — the message it throws
   * is what the caller sees.
   */
  credentials(): PlaidCredentials;
  /** Defaults to production. */
  server?: PlaidServer;
}

export class PlaidClient {
  readonly server: PlaidServer;

  private readonly credentials: () => PlaidCredentials;
  private built: { for: string; api: PlaidApi } | undefined;

  constructor(options: PlaidClientOptions) {
    this.credentials = options.credentials;
    this.server = options.server ?? "production";
  }

  /** A client for one fixed pair of keys — for trying a pair before saving it. */
  static withKeys(clientId: string, secret: string, server: PlaidServer = "production"): PlaidClient {
    return new PlaidClient({ credentials: () => ({ clientId, secret }), server });
  }

  /**
   * Does this client have both keys right now? Never throws.
   *
   * Having keys is not the same as the keys being right — Plaid decides that —
   * but a client with none cannot ask, and "no keys" is a different thing to
   * tell someone than "keys Plaid rejected".
   */
  hasCredentials(): boolean {
    try {
      const { clientId, secret } = this.credentials();
      return clientId.trim() !== "" && secret.trim() !== "";
    } catch {
      return false;
    }
  }

  /**
   * The Plaid SDK, configured with the current keys.
   *
   * Rebuilt only when the keys have changed since the last call, so a client
   * that lives as long as the process follows the profile's keys without
   * anyone having to tell it they moved.
   */
  get api(): PlaidApi {
    const { clientId, secret } = this.credentials();
    const key = `${clientId}\n${secret}`;
    if (this.built?.for === key) return this.built.api;

    const api = new PlaidApi(
      new Configuration({
        basePath: PlaidEnvironments[this.server],
        baseOptions: {
          headers: {
            "PLAID-CLIENT-ID": clientId,
            "PLAID-SECRET": secret,
            "Plaid-Version": "2020-09-14",
          },
        },
      }),
    );

    this.built = { for: key, api };
    return api;
  }
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
