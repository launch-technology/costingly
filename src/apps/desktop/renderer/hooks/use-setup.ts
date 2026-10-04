/**
 * First-run setup's behaviour, in three hooks — one per thing the screens
 * need to know or do. The screens under screens/setup/ only draw what these
 * return.
 *
 *   useSetupGate       is this machine set up, or does setup need showing?
 *   useKeysForm        the two fields, and what Plaid said about them
 *   useCreateDatabase  creating the database, and retrying if it failed
 */

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import type { Problem, SetupState } from "../../bridge/contract.js";
import { call } from "../api/client.js";

// ---------------------------------------------------------------------------
// Is setup needed?
// ---------------------------------------------------------------------------

export type SetupGate =
  | { name: "loading" }
  | { name: "setup"; state: SetupState }
  | { name: "ready" };

/**
 * Asked once, when the window opens. `finish()` is how setup hands over to the
 * rest of the app when it is done.
 */
export function useSetupGate(): { gate: SetupGate; finish(): void } {
  const [gate, setGate] = useState<SetupGate>({ name: "loading" });

  useEffect(() => {
    call("setup.state").then(
      (state) =>
        setGate(state.keysPresent && state.databaseCreated ? { name: "ready" } : { name: "setup", state }),
      // If even this cannot be read, the Status screen is the place that can
      // say what is wrong; a setup form that cannot tell what is missing is not.
      () => setGate({ name: "ready" }),
    );
  }, []);

  return { gate, finish: useCallback(() => setGate({ name: "ready" }), []) };
}

// ---------------------------------------------------------------------------
// The keys
// ---------------------------------------------------------------------------

export interface KeysFailure {
  kind: "rejected" | "unreachable";
  reason: string;
}

export interface KeysForm {
  clientId: string;
  secret: string;
  setClientId(value: string): void;
  setSecret(value: string): void;
  /** Which fields were empty at the last attempt. */
  missing: { clientId: boolean; secret: boolean };
  /** True while Plaid is being asked. */
  checking: boolean;
  failure: KeysFailure | null;
  submit(event: FormEvent): void;
}

/**
 * Two failures, handled differently because they are fixed differently. Keys
 * Plaid rejected need retyping, so the secret is cleared and the client ID is
 * kept. Plaid not answering is a network problem, so both fields are kept.
 *
 * The secret exists here while it is being typed and is handed to the main
 * process once. Nothing that comes back contains it.
 */
export function useKeysForm(onAccepted: () => void): KeysForm {
  const [clientId, setClientId] = useState("");
  const [secret, setSecret] = useState("");
  const [missing, setMissing] = useState({ clientId: false, secret: false });
  const [checking, setChecking] = useState(false);
  const [failure, setFailure] = useState<KeysFailure | null>(null);

  async function attempt(): Promise<void> {
    if (checking) return;

    const nowMissing = { clientId: clientId.trim() === "", secret: secret.trim() === "" };
    setMissing(nowMissing);
    if (nowMissing.clientId || nowMissing.secret) return;

    setChecking(true);
    setFailure(null);
    try {
      const result = await call("setup.submitKeys", clientId, secret);
      if (result.outcome === "accepted") {
        setSecret("");
        onAccepted();
        return;
      }
      if (result.outcome === "rejected") setSecret("");
      setFailure({ kind: result.outcome, reason: result.reason });
    } catch (error) {
      setFailure({
        kind: "unreachable",
        reason: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setChecking(false);
    }
  }

  return {
    clientId,
    secret,
    setClientId,
    setSecret,
    missing,
    checking,
    failure,
    submit: (event) => {
      event.preventDefault();
      void attempt();
    },
  };
}

// ---------------------------------------------------------------------------
// The database
// ---------------------------------------------------------------------------

export type DatabaseCreation =
  | { phase: "working" }
  | { phase: "ready" }
  | { phase: "failed"; problem: Problem };

/**
 * Starts on its own — there is nothing for the user to decide, and a button
 * that only says "go" is a step that should not exist.
 *
 * `retry` runs the same operation again. It is idempotent underneath, so a
 * retry after a half-finished attempt picks up rather than starting over.
 */
export function useCreateDatabase(): { creation: DatabaseCreation; retry(): void } {
  const [creation, setCreation] = useState<DatabaseCreation>({ phase: "working" });
  // One creation at a time, however many times the effect runs.
  const running = useRef(false);

  const create = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setCreation({ phase: "working" });
    try {
      const result = await call("setup.createDatabase");
      setCreation(
        result.outcome === "ready" ? { phase: "ready" } : { phase: "failed", problem: result.problem },
      );
    } catch (error) {
      // The call itself failed, which the main process does not do on purpose:
      // a creation that fails comes back as a result with its explanation.
      setCreation({
        phase: "failed",
        problem: {
          cause: `The database could not be created. ${error instanceof Error ? error.message : String(error)}`,
          nextStep: "Try again.",
        },
      });
    } finally {
      running.current = false;
    }
  }, []);

  useEffect(() => {
    void create();
  }, [create]);

  return { creation, retry: () => void create() };
}

/** Open Plaid's own site in the default browser. */
export function openPlaidSite(): void {
  void call("setup.openPlaidSite");
}

/** Open Plaid's keys page in the default browser. */
export function openPlaidKeysPage(): void {
  void call("setup.openPlaidKeysPage");
}
