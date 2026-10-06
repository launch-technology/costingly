/**
 * The "unlink this bank?" dialog.
 *
 * Drawing only; what happens is hooks/use-unlink.ts. What it must make plain:
 *
 *   WHAT GOES. The bank's name, and how many accounts and transactions are
 *   about to be deleted — read by the main process, not assumed here.
 *
 *   THE TWO THINGS "UNLINK" CAN MEAN. Deleting what is on this computer, and
 *   ending the connection at Plaid, are different acts with different
 *   consequences. The second is ticked by default because it is what stops
 *   the bank counting toward the Plaid bill; unticking it says, in so many
 *   words, that the connection stays alive and keeps costing.
 *
 *   WHEN PLAID WOULD NOT REMOVE IT. Nothing was deleted. The dialog says why,
 *   and offers the two ways on: try again, or unlink from this computer only.
 */

import { Alert } from "../../components/alert.js";
import { Button } from "../../components/button.js";
import { ConfirmDialog } from "../../components/confirm-dialog.js";
import type { Unlink, UnlinkDialogState } from "../../hooks/use-unlink.js";

export function UnlinkDialog({ unlink, dialog }: { unlink: Unlink; dialog: UnlinkDialogState }) {
  const { preview } = dialog;

  // Before the answer arrives, and when the bank cannot be unlinked at all,
  // there is nothing to confirm: a plain box with a way out.
  if (preview === null || preview.state === "unavailable") {
    return (
      <div className="fixed inset-0 z-10 flex items-center justify-center bg-slate-900/50 p-6">
        <div
          role="dialog"
          aria-modal="true"
          data-testid="unlink-dialog"
          data-state={preview === null ? "loading" : "unavailable"}
          className="w-full max-w-md rounded-lg bg-white p-6 text-sm shadow-xl dark:bg-slate-900"
        >
          {preview === null ? (
            <p>Looking up this bank…</p>
          ) : (
            <Alert data-testid="unlink-unavailable" title={preview.problem.cause}>
              <p className="mt-1">{preview.problem.nextStep}</p>
            </Alert>
          )}
          <div className="mt-4 text-right">
            <Button variant="secondary" data-testid="unlink-dialog-cancel" onClick={unlink.cancel}>
              Close
            </Button>
          </div>
        </div>
      </div>
    );
  }

  const removingAtPlaid = preview.atPlaid && dialog.removeAtPlaid;

  return (
    <ConfirmDialog
      testId="unlink-dialog"
      title={`Unlink ${preview.bankName}?`}
      confirmWord={preview.confirmWord}
      // After Plaid has refused once, the main button is another attempt at
      // the same thing, and the other way on sits beside it.
      confirmLabel={dialog.plaidFailed ? "Try again" : "Unlink"}
      onConfirm={unlink.confirm}
      {...(dialog.plaidFailed
        ? {
            alternative: {
              label: "Unlink from this computer only",
              testId: "unlink-local-only",
              onChoose: unlink.confirmLocalOnly,
            },
          }
        : {})}
      onCancel={unlink.cancel}
      working={dialog.working}
    >
      <p data-testid="unlink-summary" className="mb-3">
        {preview.summary}
      </p>

      {preview.atPlaid && <PlaidChoice state={dialog} onChange={unlink.setRemoveAtPlaid} removing={removingAtPlaid} />}

      <p className="text-slate-600 dark:text-slate-300">
        This cannot be undone. To see this bank here again you would link it from scratch.
      </p>

      {dialog.problem !== null && (
        <div className="mt-3">
          <Alert data-testid={dialog.plaidFailed ? "unlink-plaid-failed" : "unlink-failed"} title={dialog.problem.cause}>
            <p data-testid="unlink-problem-next-step" className="mt-1">
              {dialog.problem.nextStep}
            </p>
          </Alert>
        </div>
      )}
    </ConfirmDialog>
  );
}

function PlaidChoice({
  state,
  removing,
  onChange,
}: {
  state: UnlinkDialogState;
  removing: boolean;
  onChange(value: boolean): void;
}) {
  return (
    <div className="mb-3 rounded-md border border-slate-200 p-3 dark:border-slate-800">
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          data-testid="unlink-remove-at-plaid"
          checked={state.removeAtPlaid}
          disabled={state.working}
          onChange={(event) => onChange(event.target.checked)}
          className="mt-0.5"
        />
        <span className="font-medium">Also remove this bank at Plaid</span>
      </label>
      <p data-testid="unlink-plaid-explanation" className="mt-2 text-slate-600 dark:text-slate-300">
        {removing
          ? "The bank's connection at Plaid is ended, so it stops counting toward your Plaid bill."
          : "Only the data on this computer is deleted. The bank's connection stays active at Plaid and " +
            "keeps counting toward your Plaid bill; Costingly will no longer be able to remove it for you."}
      </p>
    </div>
  );
}
