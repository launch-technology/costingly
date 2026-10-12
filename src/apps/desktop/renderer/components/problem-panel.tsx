/**
 * A database problem, the way the app always says one: what is wrong, what to
 * do, and — closed until asked for — what the database itself reported.
 *
 * Used by the status screen's Database section and by setup's database step,
 * so the same failure reads the same in both.
 *
 * The details are the last lines of the database's own log, drawn by the same
 * component the Logs screen uses (the main process has already removed
 * anything secret), and where the file is.
 */

import { useState } from "react";

import type { Problem } from "../../bridge/contract.js";
import { useLogExcerpt } from "../hooks/use-database.js";
import { Button } from "./button.js";
import { LogExcerptView } from "./log-excerpt.js";

export function ProblemPanel({ problem }: { problem: Problem }) {
  const [open, setOpen] = useState(false);
  const log = useLogExcerpt(open, problem);

  return (
    <div
      role="alert"
      data-testid="database-problem"
      className="mt-3 rounded-md border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900 dark:border-rose-800 dark:bg-rose-950 dark:text-rose-100"
    >
      <p data-testid="problem-cause" className="font-medium break-words">
        {problem.cause}
      </p>
      <p data-testid="problem-next-step" className="mt-1">
        {problem.nextStep}
      </p>

      <Button
        variant="link"
        data-testid="problem-details-toggle"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        className="mt-2"
      >
        {open ? "Hide details" : "Show details"}
      </Button>

      {log.phase === "loading" && <p className="mt-2">Reading the database log…</p>}

      {log.phase === "loaded" && (
        <div className="mt-2">
          <LogExcerptView
            excerpt={log.excerpt}
            emptyText="The database has not written a log yet."
            unreadableText="The database log could not be read."
            fromPrefix="From the database log:"
            testId="problem-log"
          />
        </div>
      )}
    </div>
  );
}
