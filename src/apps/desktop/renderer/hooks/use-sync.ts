/**
 * The sync, as the Accounts screen sees it.
 *
 * THE SCREEN WATCHES A SYNC; IT DOES NOT OWN ONE. A sync runs in the main
 * process and finishes whether or not this screen exists. So this asks how
 * the sync stands when the screen appears, and listens for it changing —
 * which is also how a sync nobody here started would show up.
 *
 * `start()` asks for one and returns: the answer is "running", and the end
 * arrives later as an event like any other change.
 *
 * `onFinished` runs each time a sync ends, so whoever holds the list of banks
 * can read it again: balances and last-synced times have just changed.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { SyncView } from "../../bridge/contract.js";
import { call, on } from "../api/client.js";

export interface Sync {
  view: SyncView;
  start(): void;
}

export function useSync(onFinished: () => void): Sync {
  const [view, setView] = useState<SyncView>({ state: "idle" });
  // The latest callback, without re-subscribing every time it changes.
  const finished = useRef(onFinished);
  finished.current = onFinished;

  const take = useCallback((next: SyncView, announced: boolean) => {
    setView(next);
    // Only an end that was ANNOUNCED means something just changed. Finding an
    // old result on arrival does not: the list this screen loads is already
    // newer than it.
    if (announced && next.state === "finished") finished.current();
  }, []);

  useEffect(() => {
    let current = true;
    call("sync.state").then(
      (state) => {
        if (current) take(state, false);
      },
      () => {},
    );
    const stop = on("sync.changed", (state) => take(state, true));
    return () => {
      current = false;
      stop();
    };
  }, [take]);

  const start = useCallback(() => {
    call("sync.start").then(
      (state) => take(state, false),
      (error: unknown) =>
        take(
          {
            state: "finished",
            tone: "bad",
            summary: "The sync could not be started.",
            problem: {
              cause: `The sync could not be started: ${error instanceof Error ? error.message : String(error)}`,
              nextStep: "Try again.",
            },
            results: [],
          },
          false,
        ),
    );
  }, [take]);

  return { view, start };
}
