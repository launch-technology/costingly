/**
 * The status screen: three sections and a Refresh button.
 *
 * Drawing only. What the sections say, when they are re-checked and how a
 * failed check is shown are all hooks/use-status.ts. The Database section has
 * controls of its own and lives in database-section.tsx; the other two are
 * plain.
 */

import type { SectionId } from "../../../bridge/contract.js";
import { Button } from "../../components/button.js";
import { useStatus, type SectionState } from "../../hooks/use-status.js";
import { DatabaseSection } from "./database-section.js";
import { StatusSection } from "./status-section.js";

export function StatusScreen() {
  const { sections, checking, refresh, setDatabase } = useStatus();

  return (
    <section data-testid="status-screen" data-checking={checking ? "true" : "false"}>
      <header className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Status</h1>
        <Button variant="secondary" onClick={refresh} disabled={checking}>
          {checking ? "Checking…" : "Refresh"}
        </Button>
      </header>

      <div className="flex flex-col gap-4">
        <PlainSection id="profile" title="Profile" state={sections.profile} />
        <DatabaseSection state={sections.database} onChanged={setDatabase} />
        <PlainSection id="plaid" title="Plaid keys" state={sections.plaid} />
      </div>
    </section>
  );
}

function PlainSection({ id, title, state }: { id: SectionId; title: string; state: SectionState }) {
  if (state.phase === "checking") {
    return <StatusSection id={id} title={title} tone="neutral" headline="Checking…" details={[]} busy phase="checking" />;
  }
  const { view } = state;
  return (
    <StatusSection
      id={id}
      title={title}
      tone={view.tone}
      headline={view.headline}
      details={view.details}
      busy={false}
      phase="done"
    />
  );
}
