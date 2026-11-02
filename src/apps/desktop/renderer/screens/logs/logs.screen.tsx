/**
 * The Logs screen: what the app and its database have been doing, as text.
 *
 * Drawing only; the behaviour is hooks/use-logs.ts. Three tabs:
 *
 *   App log, Database log   each log's most recent lines, newest at the
 *                           bottom, with the file's location underneath
 *   Report                  how the app stands and the recent lines of BOTH
 *                           logs, as one piece of text to paste into an issue
 *
 * and two things to press, which act on the tab showing:
 *
 *   Refresh   read it again
 *   Copy      put exactly what is shown on the clipboard
 *
 * The report is a tab, not a button that copies unseen: it is the one thing
 * here meant to leave the machine, so it is read before it is sent.
 *
 * Nothing here filters, searches or follows. A log is for reading what
 * happened; the Status screen is for watching.
 */

import { Alert } from "../../components/alert.js";
import { Button } from "../../components/button.js";
import { Confirmation } from "../../components/confirmation.js";
import { LogExcerptView } from "../../components/log-excerpt.js";
import { useLogs, type LogsTab } from "../../hooks/use-logs.js";

const TABS: ReadonlyArray<{ id: LogsTab; label: string }> = [
  { id: "app", label: "App log" },
  { id: "database", label: "Database log" },
  { id: "report", label: "Report" },
];

export function LogsScreen() {
  const logs = useLogs();
  const shown = logs.state.phase === "loaded" ? logs.state.shown : null;
  // A log with no lines has nothing to copy; the report always has text.
  const canCopy = shown !== null && (shown.kind === "report" || shown.excerpt.state === "lines");

  return (
    <section data-testid="logs-screen" data-log={logs.tab} data-state={logs.state.phase}>
      <header className="mb-4">
        <h1 className="text-2xl font-semibold tracking-tight">Logs</h1>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
          What Costingly and its database have been doing, newest at the bottom. Your Plaid keys and the database's
          passwords are removed before anything is shown or copied.
        </p>
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Logs" className="flex gap-1 rounded-md bg-slate-100 p-1 dark:bg-slate-800">
          {TABS.map((tab) => {
            const selected = tab.id === logs.tab;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={selected}
                data-testid={`logs-tab-${tab.id}`}
                onClick={() => logs.choose(tab.id)}
                className={
                  "rounded px-3 py-1 text-sm " +
                  (selected ? "bg-white font-medium shadow-sm dark:bg-slate-900" : "hover:bg-white/60 dark:hover:bg-slate-900/60")
                }
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        <div className="ml-auto flex gap-2">
          <Button variant="secondary" data-testid="logs-refresh" disabled={logs.busy} onClick={logs.refresh}>
            Refresh
          </Button>
          <Button variant="secondary" data-testid="logs-copy" disabled={logs.busy || !canCopy} onClick={logs.copy}>
            Copy
          </Button>
        </div>
      </div>

      {logs.outcome?.kind === "copied" && <Confirmation data-testid="logs-copied">{logs.outcome.what}</Confirmation>}
      {logs.outcome?.kind === "failed" && (
        <Alert data-testid="logs-copy-problem" title={logs.outcome.problem.cause}>
          <p className="mt-1">{logs.outcome.problem.nextStep}</p>
        </Alert>
      )}

      {logs.state.phase === "loading" && (
        <p data-testid="logs-loading" className="text-sm text-slate-600 dark:text-slate-300">
          {logs.tab === "report" ? "Putting the report together. This asks Plaid, so it can take a few seconds…" : "Reading the log…"}
        </p>
      )}

      {logs.state.phase === "failed" && (
        <Alert data-testid="logs-problem" title={logs.state.problem.cause}>
          <p className="mt-1">{logs.state.problem.nextStep}</p>
        </Alert>
      )}

      {shown?.kind === "log" && (
        <div className="text-sm">
          <LogExcerptView
            excerpt={shown.excerpt}
            emptyText={logs.tab === "app" ? "The app has not written a log yet." : "The database has not written a log yet."}
            unreadableText={logs.tab === "app" ? "The app log could not be read." : "The database log could not be read."}
            fromPrefix="From:"
            testId="logs"
            className="max-h-[70vh] border border-slate-200 dark:border-slate-700"
          />
        </div>
      )}

      {/* Read from the top, unlike a log: the facts come first and the logs last. */}
      {shown?.kind === "report" && (
        <pre
          data-testid="logs-report"
          className="max-h-[70vh] overflow-auto rounded border border-slate-200 bg-white/70 p-2 text-xs leading-relaxed whitespace-pre-wrap break-words text-slate-900 dark:border-slate-700 dark:bg-black/40 dark:text-slate-100"
        >
          {shown.text}
        </pre>
      )}
    </section>
  );
}
