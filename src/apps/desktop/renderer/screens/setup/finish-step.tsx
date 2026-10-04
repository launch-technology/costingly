/**
 * The finish step: where everything lives, and the one thing worth saying
 * about it.
 *
 * The backup line is here because this is the only moment the user is certain
 * to read it. The data folder holds the key that encrypts the bank
 * connections; lose the folder and every bank has to be linked again.
 */

import { Button } from "../../components/button.js";
import { StatusDot } from "../../components/status-dot.js";

export interface FinishStepProps {
  dataFolder: string;
  onContinue(): void;
}

export function FinishStep({ dataFolder, onContinue }: FinishStepProps) {
  return (
    <div data-testid="finish-step">
      <p className="mb-4 flex items-center gap-2 text-lg">
        <StatusDot tone="good" />
        Costingly is set up.
      </p>
      <p className="mb-1 text-sm text-slate-600 dark:text-slate-300">Your data lives in:</p>
      <p data-testid="finish-data-folder" className="mb-3 break-all font-mono text-sm">
        {dataFolder}
      </p>
      <p data-testid="finish-backup-note" className="mb-5 text-sm text-slate-600 dark:text-slate-300">
        Back this folder up. It holds the key that protects your bank connections, and losing it
        means linking every bank again.
      </p>
      <Button data-testid="finish-continue" onClick={onContinue}>
        Continue
      </Button>
    </div>
  );
}
