/**
 * The status screen's behaviour: three sections, each checked on its own.
 *
 * Independence is the whole design. Each section asks the main process for
 * its own check and takes its own answer when it arrives, so a slow Plaid
 * round trip never blanks the profile and database sections beside it, and a
 * check that fails leaves the other two readable.
 *
 * Re-checks on mount, on `refresh()`, and whenever the window is shown or
 * brought to the front — and at no other time. There is no polling: status is
 * reported when someone is looking at it.
 *
 * The Database section can also be replaced directly, by the answer to a
 * database action (see use-database.ts). That touches only that section: the
 * profile and the Plaid keys are not re-checked because a database was
 * restarted.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { DatabaseSectionView, SectionView } from "../../bridge/contract.js";
import { call, on } from "../api/client.js";

export type SectionState<V extends SectionView = SectionView> =
  | { phase: "checking" }
  | { phase: "done"; view: V };

export interface StatusSections {
  profile: SectionState;
  database: SectionState<DatabaseSectionView>;
  plaid: SectionState;
}

function allChecking(): StatusSections {
  return {
    profile: { phase: "checking" },
    database: { phase: "checking" },
    plaid: { phase: "checking" },
  };
}

/** A check whose call itself failed. The checks do not throw, so this is rare. */
function couldNotCheck(error: unknown): SectionView {
  return {
    tone: "bad",
    headline: "Could not check",
    details: [error instanceof Error ? error.message : String(error)],
  };
}

export interface Status {
  sections: StatusSections;
  /** True while any section is still waiting for its answer. */
  checking: boolean;
  refresh(): void;
  /** Put the Database section in place without re-checking the others. */
  setDatabase(view: DatabaseSectionView): void;
}

export function useStatus(): Status {
  const [sections, setSections] = useState<StatusSections>(allChecking);
  // Which refresh is current. An answer from an earlier refresh that lands
  // after a later one started must not overwrite the newer "checking".
  const run = useRef(0);

  const refresh = useCallback(() => {
    const mine = ++run.current;
    setSections(allChecking());

    const settle = (change: Partial<StatusSections>): void => {
      if (run.current !== mine) return;
      setSections((previous) => ({ ...previous, ...change }));
    };

    call("status.profile").then(
      (view) => settle({ profile: { phase: "done", view } }),
      (error: unknown) => settle({ profile: { phase: "done", view: couldNotCheck(error) } }),
    );
    call("status.database").then(
      (view) => settle({ database: { phase: "done", view } }),
      (error: unknown) =>
        settle({ database: { phase: "done", view: { ...couldNotCheck(error), actions: [] } } }),
    );
    call("status.plaid").then(
      (view) => settle({ plaid: { phase: "done", view } }),
      (error: unknown) => settle({ plaid: { phase: "done", view: couldNotCheck(error) } }),
    );
  }, []);

  const setDatabase = useCallback((view: DatabaseSectionView) => {
    setSections((previous) => ({ ...previous, database: { phase: "done", view } }));
  }, []);

  useEffect(() => {
    refresh();
    return on("window.shown", refresh);
  }, [refresh]);

  return {
    sections,
    checking: Object.values(sections).some((section) => section.phase === "checking"),
    refresh,
    setDatabase,
  };
}
