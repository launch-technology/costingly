/**
 * A database problem, the way the app always says one: what is wrong, what to
 * do, and — closed until asked for — what the database itself reported.
 *
 * Used by the status screen's Database section and by setup's database step,
 * so the same failure reads the same in both.
 *
 * The details are the last lines of the database's own log, shown exactly as
 * written (the main process has already removed anything secret), and where
 * the file is.
 */

import { useEffect, useRef, useState } from "react";

import type { Problem } from "../../bridge/contract.js";
import { useLogExcerpt } from "../hooks/use-database.js";
import { Button } from "./button.js";

export function ProblemPanel({ problem }: { problem: Problem }) {
  const [open, setOpen] = useState(false);
  const log = useLogExcerpt(open, problem);

  // A log is read from the end: what just went wrong is the last thing in it.
  const lines = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (lines.current !== null) lines.current.scrollTop = lines.current.scrollHeight;
  }, [log]);

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

      {log.phase === "loaded" && log.excerpt.state === "lines" && (
        <div className="mt-2">
          <pre
            ref={lines}
            data-testid="problem-log-lines"
            className="max-h-64 overflow-auto rounded bg-white/70 p-2 text-xs leading-relaxed whitespace-pre-wrap break-words text-slate-900 dark:bg-black/40 dark:text-slate-100"
          >
            {log.excerpt.lines.join("\n")}
          </pre>
          <LogPath path={log.excerpt.path} prefix="From the database log:" />
        </div>
      )}

      {log.phase === "loaded" && log.excerpt.state === "empty" && (
        <div className="mt-2">
          <p data-testid="problem-log-empty">The database has not written a log yet.</p>
          <LogPath path={log.excerpt.path} prefix="It will be at:" />
        </div>
      )}

      {log.phase === "loaded" && log.excerpt.state === "unreadable" && (
        <div className="mt-2">
          <p data-testid="problem-log-unreadable">The database log could not be read.</p>
          {log.excerpt.path !== "" && <LogPath path={log.excerpt.path} prefix="It should be at:" />}
        </div>
      )}
    </div>
  );
}

function LogPath({ path, prefix }: { path: string; prefix: string }) {
  return (
    <p className="mt-1 text-xs">
      {prefix}{" "}
      <span data-testid="problem-log-path" className="font-mono break-all">
        {path}
      </span>
    </p>
  );
}
