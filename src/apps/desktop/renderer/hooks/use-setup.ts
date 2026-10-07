/**
 * First-run setup's behaviour, in two hooks — one per thing the screens
 * need to know or do. The screens under screens/setup/ only draw what these
 * return. The keys step's behaviour is use-keys-form.ts, shared with
 * Settings.
 *
 *   useSetupGate       is this machine set up, or does setup need showing?
 *   useCreateDatabase  creating the database, and retrying if it failed
 */

import { useCallback, useEffect, useRef, useState } from "react";

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
