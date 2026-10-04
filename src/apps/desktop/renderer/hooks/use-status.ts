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
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { SectionId, SectionView } from "../../bridge/contract.js";
import { call, on } from "../api/client.js";

export type SectionState = { phase: "checking" } | { phase: "done"; view: SectionView };

const CHECKS: Record<SectionId, () => Promise<SectionView>> = {
  profile: () => call("status.profile"),
  database: () => call("status.database"),
  plaid: () => call("status.plaid"),
};

function allChecking(): Record<SectionId, SectionState> {
  return {
    profile: { phase: "checking" },
    database: { phase: "checking" },
    plaid: { phase: "checking" },
  };
}

export interface Status {
  sections: Record<SectionId, SectionState>;
  /** True while any section is still waiting for its answer. */
  checking: boolean;
  refresh(): void;
}

export function useStatus(): Status {
  const [sections, setSections] = useState<Record<SectionId, SectionState>>(allChecking);
  // Which refresh is current. An answer from an earlier refresh that lands
  // after a later one started must not overwrite the newer "checking".
  const run = useRef(0);

  const refresh = useCallback(() => {
    const mine = ++run.current;
    setSections(allChecking());

    for (const id of Object.keys(CHECKS) as SectionId[]) {
      const settle = (view: SectionView): void => {
        if (run.current !== mine) return;
        setSections((previous) => ({ ...previous, [id]: { phase: "done", view } }));
      };

      CHECKS[id]().then(settle, (error: unknown) =>
        settle({
          tone: "bad",
          headline: "Could not check",
          details: [error instanceof Error ? error.message : String(error)],
        }),
      );
    }
  }, []);

  useEffect(() => {
    refresh();
    return on("window.shown", refresh);
  }, [refresh]);

  return {
    sections,
    checking: Object.values(sections).some((section) => section.phase === "checking"),
    refresh,
  };
}
