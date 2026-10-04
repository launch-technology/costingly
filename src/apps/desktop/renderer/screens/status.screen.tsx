/**
 * The status screen: three sections and a Refresh button.
 *
 * Drawing only. What the sections say, when they are re-checked and how a
 * failed check is shown are all hooks/use-status.ts.
 */

import type { SectionId, SectionView } from "../../bridge/contract.js";
import { Button } from "../components/button.js";
import { StatusDot } from "../components/status-dot.js";
import { useStatus, type SectionState } from "../hooks/use-status.js";

const SECTIONS: ReadonlyArray<{ id: SectionId; title: string }> = [
  { id: "profile", title: "Profile" },
  { id: "database", title: "Database" },
  { id: "plaid", title: "Plaid keys" },
];

export function StatusScreen() {
  const { sections, checking, refresh } = useStatus();

  return (
    <section data-testid="status-screen" data-checking={checking ? "true" : "false"}>
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Status</h1>
        <Button variant="secondary" onClick={refresh} disabled={checking}>
          {checking ? "Checking…" : "Refresh"}
        </Button>
      </header>

      <div className="flex flex-col gap-4">
        {SECTIONS.map((section) => (
          <StatusSection key={section.id} id={section.id} title={section.title} state={sections[section.id]} />
        ))}
      </div>
    </section>
  );
}

function StatusSection({ id, title, state }: { id: SectionId; title: string; state: SectionState }) {
  const checking = state.phase === "checking";
  const view: SectionView = checking ? { tone: "neutral", headline: "Checking…", details: [] } : state.view;

  return (
    <article
      data-testid={`section-${id}`}
      data-phase={state.phase}
      data-tone={view.tone}
      className="rounded-lg border border-slate-200 p-4 dark:border-slate-800"
    >
      <h2 className="mb-1 text-sm font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {title}
      </h2>
      <p className="flex items-center gap-2 text-lg">
        <StatusDot tone={view.tone} pulsing={checking} />
        <span data-testid={`section-${id}-headline`}>{view.headline}</span>
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
