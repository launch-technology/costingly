/**
 * The Logs screen's behaviour.
 *
 *   useLogs   which tab is being looked at — one of the two logs, or the
 *             report — what it shows, and the two things to do: refresh it,
 *             and copy it
 *
 * Nothing here follows a log live. A tab is read when the screen opens, when
 * it is chosen, and when Refresh is pressed — the Logs screen is for reading
 * what happened, not watching it happen. The report is put together the same
 * way, on the same three occasions; it asks Plaid, so it takes longer.
 *
 * A COPY SHOWS WHAT IT COPIED. The main process answers a copy with the text
 * it put on the clipboard, and that replaces what is shown, so the screen and
 * the clipboard never disagree. The report is no exception: it is read before
 * it is copied, because it is the one thing here meant to leave the machine.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { LogExcerpt, LogName, Problem } from "../../bridge/contract.js";
import { call } from "../api/client.js";

/** The screen's tabs: the two logs, and the report made from them. */
export type LogsTab = LogName | "report";

/** What a tab shows once it has been read. */
export type Shown = { kind: "log"; excerpt: LogExcerpt } | { kind: "report"; text: string };

export type LogState =
  | { phase: "loading" }
  | { phase: "loaded"; shown: Shown }
  /** The call itself failed. Rare: the main process answers "unreadable" for almost every failure. */
  | { phase: "failed"; problem: Problem };

/** What the last copy came to. Cleared by the next action. */
export type CopyOutcome = { kind: "copied"; what: string } | { kind: "failed"; problem: Problem };

export interface Logs {
  tab: LogsTab;
  choose(tab: LogsTab): void;
  state: LogState;
  /** True while a read or a copy is in flight; the buttons wait. */
  busy: boolean;
  outcome: CopyOutcome | null;
  refresh(): void;
  copy(): void;
}

const COPIED: Record<LogsTab, string> = {
  app: "The app log is on the clipboard.",
  database: "The database log is on the clipboard.",
  report: "The report is on the clipboard. Paste it into an issue or a message.",
};

/** One tab's read, whichever call it is. */
function readTab(tab: LogsTab): Promise<Shown> {
  return tab === "report"
    ? call("logs.readReport").then((view): Shown => ({ kind: "report", text: view.text }))
    : call("logs.read", tab).then((excerpt): Shown => ({ kind: "log", excerpt }));
}

/** One tab's copy: what was copied, or why it was not. */
async function copyTab(tab: LogsTab): Promise<{ copied: Shown } | { problem: Problem }> {
  if (tab === "report") {
    const result = await call("logs.copyReport");
    return result.outcome === "copied" ? { copied: { kind: "report", text: result.view.text } } : { problem: result.problem };
  }
  const result = await call("logs.copy", tab);
  return result.outcome === "copied" ? { copied: { kind: "log", excerpt: result.view } } : { problem: result.problem };
}

function failed(what: string, error: unknown): Problem {
  return {
    cause: `${what}: ${error instanceof Error ? error.message : String(error)}`,
    nextStep: "Try again. If it keeps happening, quit Costingly from the tray and reopen it.",
  };
}

export function useLogs(): Logs {
  const [tab, setTab] = useState<LogsTab>("app");
  const [state, setState] = useState<LogState>({ phase: "loading" });
  const [reading, setReading] = useState(false);
  const [copying, setCopying] = useState(false);
  const [outcome, setOutcome] = useState<CopyOutcome | null>(null);
  // Each read or copy takes the next number, and only the newest may change
  // what is shown: an answer for a tab since left is dropped, so one tab's
  // text never lands under another's name.
  const latest = useRef(0);

  const read = useCallback((name: LogsTab) => {
    const request = ++latest.current;
    const current = (): boolean => request === latest.current;
    setReading(true);
    setState({ phase: "loading" });
    readTab(name)
      .then(
        (shown) => {
          if (current()) setState({ phase: "loaded", shown });
        },
        (error: unknown) => {
          if (!current()) return;
          const what = name === "report" ? "The report could not be put together" : "The log could not be read";
          setState({ phase: "failed", problem: failed(what, error) });
        },
      )
      // A read that was overtaken leaves "reading" to the one that overtook it.
      .finally(() => {
        if (current()) setReading(false);
      });
  }, []);

  useEffect(() => {
    read(tab);
  }, [read, tab]);

  const choose = useCallback(
    (name: LogsTab) => {
      // The tab already showing: nothing to do. (Marking it loading would
      // leave it loading: the read runs only when the choice changes.)
      if (name === tab) return;
      setOutcome(null);
      // Loading at once, in the same render as the new tab: the other tab's
      // text must not sit under this tab's name while the read is in flight.
      setState({ phase: "loading" });
      setTab(name);
    },
    [tab],
  );

  const refresh = useCallback(() => {
    setOutcome(null);
    read(tab);
  }, [read, tab]);

  const copy = useCallback(() => {
    const request = ++latest.current;
    const current = (): boolean => request === latest.current;
    setCopying(true);
    setOutcome(null);
    copyTab(tab)
      .then(
        (result) => {
          // The clipboard has the text either way; what is dropped is only the
          // screen's account of it, when another tab has since been chosen.
          if (!current()) return;
          if ("copied" in result) {
            setState({ phase: "loaded", shown: result.copied });
            setOutcome({ kind: "copied", what: COPIED[tab] });
          } else {
            setOutcome({ kind: "failed", problem: result.problem });
          }
        },
        (error: unknown) => {
          if (!current()) return;
          const what = tab === "report" ? "The report could not be copied" : "The log could not be copied";
          setOutcome({ kind: "failed", problem: failed(what, error) });
        },
      )
      .finally(() => setCopying(false));
  }, [tab]);

  // Each kind of work keeps its own flag, so one finishing — a read started by
  // changing tabs, say — cannot release the buttons while another is in flight.
  const busy = reading || copying;

  return { tab, choose, state, busy, outcome, refresh, copy };
}
