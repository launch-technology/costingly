/**
 * One section of the status screen: a title, a headline with its dot, and the
 * facts beneath it. Anything a particular section adds — the Database
 * section's problem and buttons — goes in as children.
 */

import type { ReactNode } from "react";

import type { SectionId, SectionTone } from "../../../bridge/contract.js";
import { StatusDot } from "../../components/status-dot.js";

export interface StatusSectionProps {
  id: SectionId;
  title: string;
  tone: SectionTone;
  headline: string;
  details: string[];
  /** Waiting for an answer, or doing something: the dot pulses. */
  busy: boolean;
  /** `checking` until the section's first answer arrives, then `done`. */
  phase: "checking" | "done";
  children?: ReactNode;
}

export function StatusSection({
  id,
  title,
  tone,
  headline,
  details,
  busy,
  phase,
  children,
}: StatusSectionProps) {
  return (
    <article
      data-testid={`section-${id}`}
      data-phase={phase}
      data-tone={tone}
      className="rounded-lg border border-slate-200 p-4 dark:border-slate-800"
    >
      <h2 className="mb-1 text-sm font-medium uppercase tracking-wide text-slate-500 dark:text-slate-400">
        {title}
      </h2>
      <p className="flex items-center gap-2 text-lg">
        <StatusDot tone={tone} pulsing={busy} />
        <span data-testid={`section-${id}-headline`}>{headline}</span>
      </p>
      {details.length > 0 && (
        <ul className="mt-2 flex flex-col gap-0.5 text-sm text-slate-600 dark:text-slate-300">
          {details.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
      {children}
    </article>
  );
}
