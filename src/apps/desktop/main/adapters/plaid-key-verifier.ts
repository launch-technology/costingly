/**
 * Proving a pair of Plaid keys that have not been saved anywhere yet.
 *
 * It is handed a `check`: one authenticated round trip to Plaid, made with the
 * pair being offered, that fails if they are wrong. In the app that is "build
 * a Plaid client from these two keys and ask it for a link token" — the first
 * thing linking a bank does, so keys that pass here will not fail there for
 * being wrong. A test hands it a check against whichever Plaid its keys belong
 * to, or one that never answers.
 *
 * What this adds to the check is the two things a caller should not have to
 * arrange: a time limit, and telling "Plaid said no" from "Plaid did not
 * answer".
 *
 * NOTHING IS LEFT BEHIND, EITHER WAY. The pair is used for the check and
 * dropped. It takes effect only once setup has saved it, at which point the
 * app's own Plaid client reads it from the profile like any other key.
 */

import { describeError, getPlaidError } from "../../../../domain/data/plaid.client.js";
import type { KeyVerdict, KeyVerifier } from "../services/setup.service.js";

/** How long Plaid gets to answer before it counts as unreachable. */
const DEFAULT_TIMEOUT_MS = 15_000;

export interface PlaidKeyVerifierOptions {
  /** One authenticated round trip to Plaid with this pair. Rejects if Plaid refuses. */
  check(clientId: string, secret: string): Promise<unknown>;
  timeoutMs?: number;
}

export class PlaidKeyVerifier implements KeyVerifier {
  private readonly check: (clientId: string, secret: string) => Promise<unknown>;
  private readonly timeoutMs: number;

  constructor(options: PlaidKeyVerifierOptions) {
    this.check = options.check;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async verify(clientId: string, secret: string): Promise<KeyVerdict> {
    try {
      await withTimeout(this.check(clientId, secret), this.timeoutMs);
      return { accepted: true };
    } catch (error) {
      return { accepted: false, ...classifyKeyFailure(error) };
    }
  }
}

/**
 * Did Plaid say no, or did Plaid not say anything?
 *
 * A structured error body means the request arrived and was refused: the keys
 * are wrong. Anything else — DNS, a refused connection, a timeout — means it
 * never got an answer, and retyping the keys will not help.
 *
 * The reason comes from `describeError`, never from the error object: axios
 * attaches the request to it, and the request carries the secret in a header.
 */
export function classifyKeyFailure(error: unknown): {
  kind: "rejected" | "unreachable";
  reason: string;
} {
  return {
    kind: getPlaidError(error) === undefined ? "unreachable" : "rejected",
    reason: describeError(error),
  };
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no response after ${ms / 1000} seconds`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
