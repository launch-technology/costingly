/**
 * The end of a log, drawn: the lines as written, scrolled to the newest, and
 * where the file is. Or, when there are no lines, why.
 *
 * Used by the Logs screen for both logs and by the database problem panel for
 * its "Show details", so a log line reads the same wherever it is shown. The
 * main process has already removed anything secret; this draws what it is given.
 */

import { useEffect, useRef } from "react";

import type { LogExcerpt } from "../../bridge/contract.js";

export interface LogExcerptViewProps {
  excerpt: LogExcerpt;
  /** How to say there is nothing yet, e.g. "The database has not written a log yet." */
  emptyText: string;
  /** How to say it could not be read, e.g. "The database log could not be read." */
  unreadableText: string;
  /** Prefix for the file location under the lines. */
  fromPrefix: string;
  /** Test id prefix: `${prefix}-lines`, `${prefix}-empty`, `${prefix}-unreadable`, `${prefix}-path`. */
  testId: string;
  /** How tall the pane may grow before it scrolls. */
  className?: string;
}

export function LogExcerptView({ excerpt, emptyText, unreadableText, fromPrefix, testId, className }: LogExcerptViewProps) {
  // A log is read from the end: what just happened is the last thing in it.
  const pane = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (pane.current !== null) pane.current.scrollTop = pane.current.scrollHeight;
  }, [excerpt]);

  if (excerpt.state === "lines") {
    return (
      <div>
        <pre
          ref={pane}
          data-testid={`${testId}-lines`}
          className={
            "overflow-auto rounded bg-white/70 p-2 text-xs leading-relaxed whitespace-pre-wrap break-words text-slate-900 dark:bg-black/40 dark:text-slate-100 " +
            (className ?? "max-h-64")
          }
        >
          {excerpt.lines.join("\n")}
        </pre>
        <LogPath path={excerpt.path} prefix={fromPrefix} testId={testId} />
      </div>
    );
  }

  if (excerpt.state === "empty") {
    return (
      <div>
        <p data-testid={`${testId}-empty`}>{emptyText}</p>
        <LogPath path={excerpt.path} prefix="It will be at:" testId={testId} />
      </div>
    );
  }

  return (
    <div>
      <p data-testid={`${testId}-unreadable`}>{unreadableText}</p>
      {excerpt.path !== "" && <LogPath path={excerpt.path} prefix="It should be at:" testId={testId} />}
    </div>
  );
}

function LogPath({ path, prefix, testId }: { path: string; prefix: string; testId: string }) {
  return (
    <p className="mt-1 text-xs">
      {prefix}{" "}
      <span data-testid={`${testId}-path`} className="font-mono break-all">
        {path}
      </span>
    </p>
  );
}
