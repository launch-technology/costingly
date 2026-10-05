/**
 * The Accounts screen's behaviour, in two hooks.
 *
 *   useAccounts   the linked banks, and when to read them again
 *   useLinkBank   opening the bank login in the user's browser, to link a
 *                 bank or to reconnect one
 *
 * The list is read on mount, whenever the window is shown or brought forward,
 * and when asked. Never on a timer.
 *
 * THAT IS ALSO HOW A NEWLY LINKED BANK APPEARS. Linking happens in the user's
 * browser, where the app cannot see it finish — but coming back from the
 * browser brings this window forward, and that re-reads the list.
 *
 * WHAT IS ON SCREEN STAYS WHILE IT IS RE-READ. The list only shows "loading"
 * the first time; after that a reload keeps the banks where they are until the
 * new answer arrives, so coming back to the window does not blank it.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { AccountsView, Problem } from "../../bridge/contract.js";
import { call, on } from "../api/client.js";

export type AccountsState = { phase: "loading" } | { phase: "loaded"; view: AccountsView };

export function useAccounts(): { accounts: AccountsState; reload(): void } {
  const [accounts, setAccounts] = useState<AccountsState>({ phase: "loading" });
  // Which read is current: a slow earlier answer must not replace a later one.
  const run = useRef(0);

  const reload = useCallback(() => {
    const mine = ++run.current;
    const settle = (view: AccountsView): void => {
      if (run.current === mine) setAccounts({ phase: "loaded", view });
    };

    call("accounts.list").then(settle, (error: unknown) =>
      settle({
        state: "failed",
        problem: {
          cause: `The accounts could not be read: ${error instanceof Error ? error.message : String(error)}`,
          nextStep: "Check the Status screen, then try again.",
        },
      }),
    );
  }, []);

  useEffect(() => {
    reload();
    return on("window.shown", reload);
  }, [reload]);

  return { accounts, reload };
}

export interface LinkBank {
  /** The browser was asked to open the bank login, and nothing has gone wrong since. */
  opened: boolean;
  /** Why it could not be opened, until the next attempt. */
  problem: Problem | null;
  /** Open the bank login in the user's browser. */
  open(): void;
  /** Open the browser to reconnect a bank whose login has expired. */
  reconnect(bankId: string): void;
}

/**
 * Linking a bank means sending the user to their own browser, on costingly's
 * local link page. All this knows is whether the browser was asked to open;
 * what happens there is between the user, Plaid and the bank.
 */
export function useLinkBank(): LinkBank {
  const [opened, setOpened] = useState(false);
  const [problem, setProblem] = useState<Problem | null>(null);

  // Linking and reconnecting end the same way from here: a browser was asked
  // to open, or it was not.
  const send = useCallback((asked: Promise<void>) => {
    setProblem(null);
    asked.then(
      () => setOpened(true),
      (error: unknown) => {
        setOpened(false);
        setProblem({
          cause: `The bank login could not be opened in your browser: ${error instanceof Error ? error.message : String(error)}`,
          nextStep: "Try again. If it keeps happening, quit Costingly from the tray and reopen it.",
        });
      },
    );
  }, []);

  const open = useCallback(() => send(call("link.openInBrowser")), [send]);
  const reconnect = useCallback((bankId: string) => send(call("link.reconnectInBrowser", bankId)), [send]);

  return { opened, problem, open, reconnect };
}
