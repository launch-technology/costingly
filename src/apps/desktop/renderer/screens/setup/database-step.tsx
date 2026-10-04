/**
 * The database step: creating it, and saying so while it happens.
 *
 * Drawing only; the creation itself is useCreateDatabase. The first run does
 * real work, which takes a few seconds, and silence for that long reads as a
 * hang — hence the line under the working state.
 *
 * A failure is shown with the same panel as the status screen's Database
 * section: what went wrong, what to do, and the database's own log on request.
 */

import { Button } from "../../components/button.js";
import { ProblemPanel } from "../../components/problem-panel.js";
import { StatusDot } from "../../components/status-dot.js";
import { useCreateDatabase } from "../../hooks/use-setup.js";

export function DatabaseStep({ onReady }: { onReady(): void }) {
  const { creation, retry } = useCreateDatabase();

  return (
    <div data-testid="database-step" data-phase={creation.phase}>
      {creation.phase === "working" && (
        <>
          <p className="mb-2 flex items-center gap-2 text-lg">
            <StatusDot tone="neutral" pulsing />
            Creating your database…
          </p>
          <p className="text-sm text-slate-600 dark:text-slate-300">
            This takes a few seconds the first time.
          </p>
        </>
      )}

      {creation.phase === "ready" && (
        <>
          <p className="mb-4 flex items-center gap-2 text-lg">
            <StatusDot tone="good" />
            Your database is ready.
          </p>
          <Button data-testid="database-continue" onClick={onReady}>
            Continue
          </Button>
        </>
      )}

      {creation.phase === "failed" && (
        <div data-testid="database-error">
          <p className="flex items-center gap-2 text-lg">
            <StatusDot tone="bad" />
            The database could not be created.
          </p>
          <ProblemPanel problem={creation.problem} />
          <Button data-testid="database-retry" onClick={retry} className="mt-4">
            Retry
          </Button>
        </div>
      )}
    </div>
  );
}
