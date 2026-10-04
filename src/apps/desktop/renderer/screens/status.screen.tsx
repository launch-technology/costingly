/**
 * The status screen: three sections, each checked on its own.
 *
 * Independence is the whole design. Each section asks the main process for
 * its own check and shows its own answer when it arrives, so a slow Plaid
 * round trip never blanks the profile and database sections beside it, and a
 * check that fails leaves the other two readable.
 *
 * Re-checks on mount, on Refresh, and whenever the window is shown or brought
 * to the front — and at no other time. There is no polling: this screen
 * reports when someone is looking at it.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { SectionId, SectionTone, SectionView } from "../../status-view.types.js";

type SectionState = { phase: "checking" } | { phase: "done"; view: SectionView };

interface SectionSpec {
  id: SectionId;
  title: string;
  check(): Promise<SectionView>;
}

const SECTIONS: ReadonlyArray<SectionSpec> = [
  { id: "profile", title: "Profile", check: () => window.costingly.status.profile() },
  { id: "database", title: "Database", check: () => window.costingly.status.database() },
  { id: "plaid", title: "Plaid keys", check: () => window.costingly.status.plaid() },
];

function allChecking(): Record<SectionId, SectionState> {
  return {
    profile: { phase: "checking" },
    database: { phase: "checking" },
    plaid: { phase: "checking" },
  };
}

export function StatusScreen() {
  const [states, setStates] = useState<Record<SectionId, SectionState>>(allChecking);
  // Which refresh is current. An answer from an earlier refresh that lands
  // after a later one started must not overwrite the newer "checking".
  const run = useRef(0);

  const refresh = useCallback(() => {
    const mine = ++run.current;
    setStates(allChecking());

    for (const section of SECTIONS) {
      section.check().then(
        (view) => {
          if (run.current !== mine) return;
          setStates((previous) => ({ ...previous, [section.id]: { phase: "done", view } }));
        },
        (error: unknown) => {
          if (run.current !== mine) return;
          const view: SectionView = {
            tone: "bad",
            headline: "Could not check",
            details: [error instanceof Error ? error.message : String(error)],
          };
          setStates((previous) => ({ ...previous, [section.id]: { phase: "done", view } }));
        },
      );
    }
  }, []);

  useEffect(() => {
    refresh();
    return window.costingly.onWindowShown(refresh);
  }, [refresh]);

  const checking = Object.values(states).some((state) => state.phase === "checking");

  return (
    <section data-testid="status-screen" data-checking={checking ? "true" : "false"}>
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Status</h1>
        <button
          type="button"
          onClick={refresh}
          disabled={checking}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:cursor-default disabled:opacity-60 dark:border-slate-700 dark:hover:bg-slate-800"
        >
          {checking ? "Checking…" : "Refresh"}
        </button>
      </header>

      <div className="flex flex-col gap-4">
        {SECTIONS.map((section) => (
          <StatusSection key={section.id} spec={section} state={states[section.id]} />
        ))}
      </div>
    </section>
  );
}

const TONE_CLASS: Record<SectionTone, string> = {
  neutral: "bg-slate-400",
  good: "bg-emerald-500",
  warn: "bg-amber-500",
  bad: "bg-rose-500",
};

function StatusSection({ spec, state }: { spec: SectionSpec; state: SectionState }) {
  const view: SectionView =
    state.phase === "checking"
      ? { tone: "neutral", headline: "Checking…", details: [] }
      : state.view;

  return (
    <article
      data-testid={`section-${spec.id}`}
      data-phase={state.phase}
      data-tone={view.tone}
      className="rounded-lg border border-slate-200 p-4 dark:border-slate-800"
    >
      <h2 className="mb-1 text-sm font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {spec.title}
      </h2>
      <p className="flex items-center gap-2 text-lg">
        <span
          aria-hidden="true"
          className={
            `inline-block h-2.5 w-2.5 rounded-full ${TONE_CLASS[view.tone]}` +
            (state.phase === "checking" ? " animate-pulse" : "")
          }
        />
        <span data-testid={`section-${spec.id}-headline`}>{view.headline}</span>
      </p>
      {view.details.length > 0 && (
        <ul className="mt-2 flex flex-col gap-0.5 text-sm text-slate-600 dark:text-slate-300">
          {view.details.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </article>
  );
}
