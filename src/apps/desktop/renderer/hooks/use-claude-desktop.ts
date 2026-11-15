/**
 * The Claude Desktop screen's behaviour.
 *
 *   useClaudeDesktop   how things stand, re-read when the window returns and
 *                      on Refresh; Open folder, with its outcome
 *
 * Nothing is pushed from the main process: whether the extension has been
 * heard from is read when asked. An answer for a request since overtaken is
 * dropped, so a slow read never lands over a newer one.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { ClaudeDesktopView, Problem } from "../../bridge/contract.js";
import { call, on } from "../api/client.js";

export type ClaudeDesktopState =
  | { phase: "loading" }
  | { phase: "loaded"; view: ClaudeDesktopView }
  /** The call itself failed. Rare: the main process answers with a view for every state it knows. */
  | { phase: "failed"; problem: Problem };

/** What the last Open folder came to. Cleared by the next action. */
export type OpenOutcome = { kind: "opened" } | { kind: "failed"; problem: Problem };

export interface ClaudeDesktop {
  state: ClaudeDesktopState;
  /** True while the main process is being asked; the buttons wait. */
  busy: boolean;
  outcome: OpenOutcome | null;
  reload(): void;
  openFolder(): void;
}

function failed(what: string, error: unknown): Problem {
  return {
    cause: `${what}: ${error instanceof Error ? error.message : String(error)}`,
    nextStep: "Try again. If it keeps happening, quit Costingly from the tray and reopen it.",
  };
}

export function useClaudeDesktop(): ClaudeDesktop {
  const [state, setState] = useState<ClaudeDesktopState>({ phase: "loading" });
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<OpenOutcome | null>(null);
  const latest = useRef(0);

  const reload = useCallback(() => {
    const mine = ++latest.current;
    const current = (): boolean => mine === latest.current;
    setBusy(true);
    call("claudeDesktop.read")
      .then(
        (view) => {
          if (current()) setState({ phase: "loaded", view });
        },
        (error: unknown) => {
          if (current()) setState({ phase: "failed", problem: failed("The screen could not be read", error) });
        },
      )
      .finally(() => {
        if (current()) setBusy(false);
      });
  }, []);

  useEffect(() => {
    reload();
    return on("window.shown", reload);
  }, [reload]);

  const openFolder = useCallback(() => {
    setBusy(true);
    setOutcome(null);
    call("claudeDesktop.openFolder")
      .then(
        (result) => setOutcome(result.outcome === "opened" ? { kind: "opened" } : { kind: "failed", problem: result.problem }),
        (error: unknown) => setOutcome({ kind: "failed", problem: failed("The folder could not be opened", error) }),
      )
      .finally(() => setBusy(false));
  }, []);

  return { state, busy, outcome, reload, openFolder };
}
