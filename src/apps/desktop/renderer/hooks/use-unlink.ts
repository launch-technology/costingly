/**
 * Unlinking a bank, from the button to the result.
 *
 * One bank at a time: `open` looks up what unlinking it would delete, and the
 * dialog stays up until the bank is unlinked or the user backs out.
 *
 * WHAT IT REMEMBERS WHILE THE DIALOG IS OPEN
 *
 *   the preview        read by the main process from the bank's id — the name
 *                      and counts shown are never the window's own
 *   the Plaid choice   whether to end the connection at Plaid too. On by
 *                      default; the user can turn it off
 *   what went wrong    if Plaid could not remove the bank, nothing was
 *                      deleted, and the dialog offers to try again or to
 *                      unlink from this computer only
 *
 * `onUnlinked` runs once a bank has gone, so whoever holds the list of banks
 * can read it again.
 */

import { useCallback, useState } from "react";

import type { Problem, UnlinkPreview } from "../../bridge/contract.js";
import { call } from "../api/client.js";

export interface UnlinkDialogState {
  bankId: string;
  /** Null until the main process has answered. */
  preview: UnlinkPreview | null;
  removeAtPlaid: boolean;
  working: boolean;
  /** Set after an attempt that did not unlink the bank. */
  problem: Problem | null;
  /** That problem was Plaid's: trying again, or unlinking here only, are both on offer. */
  plaidFailed: boolean;
}

export interface Unlink {
  /** The open dialog, or null when none is. */
  dialog: UnlinkDialogState | null;
  /** What the last successful unlink did, in a sentence, until the next one starts. */
  unlinked: string | null;
  open(bankId: string): void;
  cancel(): void;
  setRemoveAtPlaid(value: boolean): void;
  /** Unlink as chosen. */
  confirm(): void;
  /** Unlink from this computer only, whatever the box says. */
  confirmLocalOnly(): void;
}

function asProblem(error: unknown): Problem {
  return {
    cause: `The bank could not be unlinked: ${error instanceof Error ? error.message : String(error)}`,
    nextStep: "Try again.",
  };
}

export function useUnlink(onUnlinked: () => void): Unlink {
  const [dialog, setDialog] = useState<UnlinkDialogState | null>(null);
  const [unlinked, setUnlinked] = useState<string | null>(null);

  const open = useCallback((bankId: string) => {
    setUnlinked(null);
    setDialog({ bankId, preview: null, removeAtPlaid: true, working: false, problem: null, plaidFailed: false });
    const arrived = (preview: UnlinkPreview): void =>
      setDialog((current) => (current !== null && current.bankId === bankId ? { ...current, preview } : current));
    call("accounts.unlinkPreview", bankId).then(arrived, (error: unknown) =>
      arrived({ state: "unavailable", problem: asProblem(error) }),
    );
  }, []);

  const cancel = useCallback(() => setDialog((current) => (current?.working === true ? current : null)), []);

  const setRemoveAtPlaid = useCallback(
    (value: boolean) =>
      setDialog((current) => (current === null ? current : { ...current, removeAtPlaid: value, problem: null, plaidFailed: false })),
    [],
  );

  const run = useCallback(
    (bankId: string, removeAtPlaid: boolean) => {
      setDialog((current) => (current === null ? current : { ...current, working: true, problem: null }));
      const failed = (problem: Problem, plaidFailed: boolean): void =>
        setDialog((current) => (current === null ? current : { ...current, working: false, problem, plaidFailed }));

      call("accounts.unlink", bankId, removeAtPlaid).then(
        (result) => {
          if (result.outcome === "unlinked") {
            setDialog(null);
            setUnlinked(result.message);
            onUnlinked();
            return;
          }
          failed(result.problem, result.outcome === "plaid-failed");
        },
        (error: unknown) => failed(asProblem(error), false),
      );
    },
    [onUnlinked],
  );

  const confirm = useCallback(() => {
    if (dialog !== null && !dialog.working) run(dialog.bankId, dialog.removeAtPlaid);
  }, [dialog, run]);

  const confirmLocalOnly = useCallback(() => {
    if (dialog !== null && !dialog.working) run(dialog.bankId, false);
  }, [dialog, run]);

  return { dialog, unlinked, open, cancel, setRemoveAtPlaid, confirm, confirmLocalOnly };
}
