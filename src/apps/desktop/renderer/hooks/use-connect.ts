/**
 * The Connect screen's behaviour.
 *
 *   useConnect   how the endpoint stands, re-read when the window returns;
 *                Try again; Show and Hide for the token; the two copies
 *
 * THE TOKEN IS HELD ONLY WHILE IT IS SHOWING. It arrives when Show is
 * pressed, goes when Hide is pressed, and goes with the screen when the user
 * leaves it. Copying it never brings it here at all: the main process puts it
 * on the clipboard itself.
 *
 * An answer for a request since overtaken is dropped, so a slow read never
 * lands over a newer one.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { ConnectView, Problem } from "../../bridge/contract.js";
import { call, on } from "../api/client.js";

export type ConnectState =
  | { phase: "loading" }
  | { phase: "loaded"; view: ConnectView }
  /** The call itself failed. Rare: the main process answers with a view for every state it knows. */
  | { phase: "failed"; problem: Problem };

/** What the last copy, or the last Show, came to. Cleared by the next action. */
export type ConnectOutcome = { kind: "copied"; what: string } | { kind: "failed"; problem: Problem };

export interface Connect {
  state: ConnectState;
  /** The token, while it is showing. */
  token: string | null;
  /** True while the main process is being asked; the buttons wait. */
  busy: boolean;
  outcome: ConnectOutcome | null;
  reload(): void;
  retry(): void;
  showToken(): void;
  hideToken(): void;
  copyAddress(): void;
  copyToken(): void;
}

function failed(what: string, error: unknown): Problem {
  return {
    cause: `${what}: ${error instanceof Error ? error.message : String(error)}`,
    nextStep: "Try again. If it keeps happening, quit Costingly from the tray and reopen it.",
  };
}

export function useConnect(): Connect {
  const [state, setState] = useState<ConnectState>({ phase: "loading" });
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ConnectOutcome | null>(null);
  const latest = useRef(0);

  const read = useCallback((request: () => Promise<ConnectView>, what: string) => {
    const mine = ++latest.current;
    const current = (): boolean => mine === latest.current;
    setBusy(true);
    request()
      .then(
        (view) => {
          if (current()) setState({ phase: "loaded", view });
        },
        (error: unknown) => {
          if (current()) setState({ phase: "failed", problem: failed(what, error) });
        },
      )
      .finally(() => {
        if (current()) setBusy(false);
      });
  }, []);

  const reload = useCallback(() => read(() => call("connect.read"), "The endpoint could not be read"), [read]);

  const retry = useCallback(() => {
    setOutcome(null);
    setState({ phase: "loading" });
    read(() => call("connect.retry"), "The endpoint could not be started");
  }, [read]);

  useEffect(() => {
    reload();
    return on("window.shown", reload);
  }, [reload]);

  const showToken = useCallback(() => {
    setBusy(true);
    setOutcome(null);
    call("connect.showToken")
      .then(
        (result) => {
          if (result.outcome === "shown") setToken(result.token);
          else setOutcome({ kind: "failed", problem: result.problem });
        },
        (error: unknown) => setOutcome({ kind: "failed", problem: failed("The token could not be shown", error) }),
      )
      .finally(() => setBusy(false));
  }, []);

  const hideToken = useCallback(() => setToken(null), []);

  const copy = useCallback((request: "connect.copyAddress" | "connect.copyToken", what: string, said: string) => {
    setBusy(true);
    setOutcome(null);
    call(request)
      .then(
        (result) =>
          setOutcome(result.outcome === "copied" ? { kind: "copied", what: said } : { kind: "failed", problem: result.problem }),
        (error: unknown) => setOutcome({ kind: "failed", problem: failed(what, error) }),
      )
      .finally(() => setBusy(false));
  }, []);

  const copyAddress = useCallback(
    () => copy("connect.copyAddress", "The address could not be copied", "The address is on the clipboard."),
    [copy],
  );
  const copyToken = useCallback(
    () => copy("connect.copyToken", "The token could not be copied", "The token is on the clipboard."),
    [copy],
  );

  return { state, token, busy, outcome, reload, retry, showToken, hideToken, copyAddress, copyToken };
}
