/**
 * Proving a pair of Plaid keys that have not been saved anywhere yet.
 *
 * AN ADAPTER, BECAUSE THE DOMAIN IS AWKWARD HERE. Costingly's Plaid client
 * reads its keys from configuration and is built once and remembered. There is
 * no "try these keys" call. So trying a pair means three things nothing else
 * should have to know about:
 *
 *   1. put the pair where the configuration layer looks first — the process
 *      environment — so the client picks them up without anything on disk;
 *   2. drop the remembered client, so the next call builds one from them;
 *   3. make one cheap real call, and read the answer.
 *
 * `costingly init` does the same three things inline. Here they sit behind one
 * method, so the service that uses it says only "verify these".
 *
 * ON REFUSAL EVERYTHING IS PUT BACK. Keys Plaid rejected must not stay in
 * effect for the rest of the process, where the status screen would report
 * them as "present". On acceptance they stay: they are about to be saved, and
 * from then on the environment and the file agree.
 */

import { describeError, getPlaidError } from "../../../../domain/data/plaid.client.js";
import type { KeyVerdict, KeyVerifier } from "../services/setup.service.js";

/** How long Plaid gets to answer before it counts as unreachable. */
const DEFAULT_TIMEOUT_MS = 15_000;

export interface PlaidKeyVerifierOptions {
  /**
   * One authenticated round trip to Plaid that fails if the keys are wrong.
   * In the app, the link-token call — the first thing linking a bank does, so
   * keys that pass here will not fail there for being wrong.
   */
  check(): Promise<unknown>;
  timeoutMs?: number;
  /** Where the configuration layer reads keys from. The real one, in the app. */
  env?: NodeJS.ProcessEnv;
}

export class PlaidKeyVerifier implements KeyVerifier {
  private readonly check: () => Promise<unknown>;
  private readonly timeoutMs: number;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: PlaidKeyVerifierOptions) {
    this.check = options.check;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.env = options.env ?? process.env;
  }

  async verify(clientId: string, secret: string): Promise<KeyVerdict> {
    const previous = { id: this.env["PLAID_CLIENT_ID"], secret: this.env["PLAID_SECRET"] };

    this.env["PLAID_CLIENT_ID"] = clientId;
    this.env["PLAID_SECRET"] = secret;
    forgetPlaidClient();

    try {
      await withTimeout(this.check(), this.timeoutMs);
      return { accepted: true };
    } catch (error) {
      this.restore("PLAID_CLIENT_ID", previous.id);
      this.restore("PLAID_SECRET", previous.secret);
      forgetPlaidClient();
      return { accepted: false, ...classifyKeyFailure(error) };
    }
  }

  private restore(name: string, value: string | undefined): void {
    if (value === undefined) delete this.env[name];
    else this.env[name] = value;
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

/**
 * Drop the remembered Plaid client so the next call builds one from the
 * current keys. Without this a retry after a rejection reuses the client built
 * from the rejected pair and reports the same error against the new ones.
 */
function forgetPlaidClient(): void {
  delete (globalThis as Record<string, unknown>)["__costinglyClient"];
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
