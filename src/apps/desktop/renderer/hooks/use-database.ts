/**
 * The database's controls, and the end of its log.
 *
 *   useDatabaseActions   run Start / Stop / Restart / Retry / Create, one at a
 *                        time, and hand back the Database section as it is
 *                        afterwards
 *   useLogExcerpt        the last lines of the database's log, loaded when
 *                        someone opens "Show details"
 */

import { useCallback, useEffect, useState } from "react";

import type {
  DatabaseAction,
  DatabaseSectionView,
  LogExcerpt,
  Problem,
} from "../../bridge/contract.js";
import { call } from "../api/client.js";

const CALLS = {
  start: "database.start",
  stop: "database.stop",
  restart: "database.restart",
  update: "database.update",
  create: "database.create",
} as const satisfies Record<DatabaseAction, string>;

export interface DatabaseActions {
  /** The action in progress, if any. Nothing else can be started meanwhile. */
  running: DatabaseAction | null;
  run(action: DatabaseAction): void;
}

/**
 * Every action answers with the section as it now is — a failure included, as
 * a section that explains it — so there is nothing to handle here but passing
 * that answer on.
 */
export function useDatabaseActions(onDone: (view: DatabaseSectionView) => void): DatabaseActions {
  const [running, setRunning] = useState<DatabaseAction | null>(null);

  const run = useCallback(
    (action: DatabaseAction) => {
      if (running !== null) return;
      setRunning(action);
      call(CALLS[action])
        .then(onDone, (error: unknown) =>
          onDone({
            tone: "bad",
            headline: "Could not check",
            details: [error instanceof Error ? error.message : String(error)],
            actions: [],
          }),
        )
        .finally(() => setRunning(null));
    },
    [running, onDone],
  );

  return { running, run };
}

export type LogExcerptState = { phase: "closed" } | { phase: "loading" } | { phase: "loaded"; excerpt: LogExcerpt };

/**
 * Loaded when opened, and again if the problem it belongs to changes while it
 * is open — a different failure wrote different lines.
 */
export function useLogExcerpt(open: boolean, problem: Problem): LogExcerptState {
  const [state, setState] = useState<LogExcerptState>({ phase: "closed" });

  useEffect(() => {
    if (!open) {
      setState({ phase: "closed" });
      return;
    }

    let current = true;
    setState({ phase: "loading" });
    call("database.logExcerpt").then(
      (excerpt) => {
        if (current) setState({ phase: "loaded", excerpt });
      },
      () => {
        if (current) setState({ phase: "loaded", excerpt: { state: "unreadable", path: "" } });
      },
    );
    return () => {
      current = false;
    };
  }, [open, problem.cause, problem.nextStep]);

  return state;
}
