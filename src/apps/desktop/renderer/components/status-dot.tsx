/**
 * The small coloured dot beside a headline: how something is, at a glance.
 * Decorative — the words beside it carry the meaning.
 */

import type { SectionTone } from "../../bridge/contract.js";

const TONE: Record<SectionTone, string> = {
  neutral: "bg-slate-400",
  good: "bg-emerald-500",
  warn: "bg-amber-500",
  bad: "bg-rose-500",
};

export function StatusDot({ tone, pulsing = false }: { tone: SectionTone; pulsing?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block h-2.5 w-2.5 rounded-full ${TONE[tone]}${pulsing ? " animate-pulse" : ""}`}
    />
  );
}
