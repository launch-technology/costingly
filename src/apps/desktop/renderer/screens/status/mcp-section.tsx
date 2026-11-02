/**
 * The status screen's MCP endpoint section: whether local MCP clients can
 * reach the app, what is wrong if they cannot, and Try again when that would
 * help.
 *
 * Drawing only. Whether Try again applies and what a failure says both arrive
 * from the main process in the section's view; what pressing it does is
 * useStatus's `retryMcp`.
 */

import type { McpSectionView } from "../../../bridge/contract.js";
import { Alert } from "../../components/alert.js";
import { Button } from "../../components/button.js";
import type { SectionState } from "../../hooks/use-status.js";
import { StatusSection } from "./status-section.js";

export interface McpSectionProps {
  state: SectionState<McpSectionView>;
  onRetry(): void;
}

export function McpSection({ state, onRetry }: McpSectionProps) {
  if (state.phase === "checking") {
    return (
      <StatusSection id="mcp" title="MCP endpoint" tone="neutral" headline="Checking…" details={[]} busy phase="checking" />
    );
  }

  const { view } = state;

  return (
    <StatusSection
      id="mcp"
      title="MCP endpoint"
      tone={view.tone}
      headline={view.headline}
      details={view.details}
      busy={false}
      phase="done"
    >
      {view.problem !== undefined && (
        <div className="mt-3">
          <Alert data-testid="mcp-problem" title={view.problem.cause}>
            <p className="mt-1">{view.problem.nextStep}</p>
          </Alert>
        </div>
      )}
      {view.canRetry && (
        <div className="mt-3">
          <Button variant="secondary" data-testid="mcp-retry" onClick={onRetry}>
            Try again
          </Button>
        </div>
      )}
    </StatusSection>
  );
}
