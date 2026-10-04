/**
 * The status screen's Database section: how it is, what is wrong if anything,
 * and the buttons that fit.
 *
 * Drawing only. Which buttons to show and what a failure says both arrive
 * from the main process in the section's view; what pressing one does is
 * useDatabaseActions. This file adds only the labels and the "…ing" wording
 * shown while an action runs.
 */

import type { DatabaseAction, DatabaseSectionView } from "../../../bridge/contract.js";
import { Button } from "../../components/button.js";
import { ProblemPanel } from "../../components/problem-panel.js";
import { useDatabaseActions } from "../../hooks/use-database.js";
import type { SectionState } from "../../hooks/use-status.js";
import { StatusSection } from "./status-section.js";

const LABEL: Record<DatabaseAction, string> = {
  start: "Start",
  stop: "Stop",
  restart: "Restart",
  update: "Retry",
  create: "Create database",
};

const IN_PROGRESS: Record<DatabaseAction, string> = {
  start: "Starting…",
  stop: "Stopping…",
  restart: "Restarting…",
  update: "Updating…",
  create: "Creating…",
};

export interface DatabaseSectionProps {
  state: SectionState<DatabaseSectionView>;
  /** An action finished; this is the section as it is now. */
  onChanged(view: DatabaseSectionView): void;
}

export function DatabaseSection({ state, onChanged }: DatabaseSectionProps) {
  const { running, run } = useDatabaseActions(onChanged);

  if (state.phase === "checking") {
    return (
      <StatusSection id="database" title="Database" tone="neutral" headline="Checking…" details={[]} busy phase="checking" />
    );
  }

  const { view } = state;

  return (
    <StatusSection
      id="database"
      title="Database"
      // While something is running the old verdict no longer applies: the
      // section says what is happening, and waits to say how it turned out.
      tone={running === null ? view.tone : "neutral"}
      headline={running === null ? view.headline : IN_PROGRESS[running]}
      details={running === null ? view.details : []}
      busy={running !== null}
      phase="done"
    >
      {running === null && view.problem !== undefined && <ProblemPanel problem={view.problem} />}

      {view.actions.length > 0 && (
        <div className="mt-3 flex gap-2" data-testid="database-actions" data-running={running ?? ""}>
          {view.actions.map((action) => (
            <Button
              key={action}
              variant="secondary"
              data-testid={`database-action-${action}`}
              disabled={running !== null}
              onClick={() => run(action)}
            >
              {LABEL[action]}
            </Button>
          ))}
        </div>
      )}
    </StatusSection>
  );
}
