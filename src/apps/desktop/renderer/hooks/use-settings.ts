/**
 * The Settings screen's behaviour.
 *
 *   useSettings   the facts the screen shows, re-read when the window returns
 *                 and after anything here changes
 *
 * Changing the keys is useKeysForm (use-keys-form.ts), the same hook
 * first-run setup uses; the screen wires its "accepted" callback to `reload`
 * so the client ID shown is the one just saved.
 *
 * THE SWITCH SHOWS WHAT WINDOWS HAS. Asking for start-at-sign-in to change
 * answers with the registration as it is afterwards, read back — so a change
 * Windows refused leaves the switch where it was, with the reason beside it.
 */

import { useCallback, useEffect, useState } from "react";

import type { Problem, SettingsView } from "../../bridge/contract.js";
import { call, on } from "../api/client.js";

export type SettingsState =
  | { phase: "loading" }
  | { phase: "loaded"; view: SettingsView }
  /** The settings could not be read at all. Rare: the main process answers for almost every failure. */
  | { phase: "failed"; problem: Problem };

export interface StartAtSignIn {
  /** True while Windows is being asked. */
  changing: boolean;
  /** What the last change said: confirmed on or off, until the next change. */
  confirmed: string | null;
  problem: Problem | null;
  set(on: boolean): void;
}

export interface Settings {
  state: SettingsState;
  reload(): void;
  startAtSignIn: StartAtSignIn;
}

export function useSettings(): Settings {
  const [state, setState] = useState<SettingsState>({ phase: "loading" });
  const [changing, setChanging] = useState(false);
  const [confirmed, setConfirmed] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);

  const reload = useCallback(() => {
    call("settings.read").then(
      (view) => setState({ phase: "loaded", view }),
      (error: unknown) =>
        setState({
          phase: "failed",
          problem: {
            cause: `The settings could not be read: ${error instanceof Error ? error.message : String(error)}`,
            nextStep: "Try again. If it keeps happening, quit Costingly from the tray and reopen it.",
          },
        }),
    );
  }, []);

  useEffect(() => {
    reload();
    return on("window.shown", reload);
  }, [reload]);

  const set = useCallback((on: boolean) => {
    setChanging(true);
    setConfirmed(null);
    setProblem(null);
    const settle = (now: boolean): void =>
      setState((current) => (current.phase === "loaded" ? { phase: "loaded", view: { ...current.view, startAtSignIn: now } } : current));

    // The switch moves at once, as a switch should; Windows' answer then
    // settles it, and a refused change puts it straight back.
    settle(on);
    call("settings.setStartAtSignIn", on)
      .then((result) => {
        settle(result.on);
        if (result.outcome === "set") {
          setConfirmed(result.on ? "Costingly will start when you sign in." : "Costingly will not start when you sign in.");
        } else {
          setProblem(result.problem);
        }
      })
      .catch((error: unknown) => {
        setProblem({
          cause: `The start-at-sign-in setting could not be changed: ${error instanceof Error ? error.message : String(error)}`,
          nextStep: "Try again.",
        });
      })
      .finally(() => setChanging(false));
  }, []);

  return { state, reload, startAtSignIn: { changing, confirmed, problem, set } };
}
