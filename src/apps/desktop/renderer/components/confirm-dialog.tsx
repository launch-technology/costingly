/**
 * "Are you sure?" for something that cannot be taken back: a dialog over the
 * window that will not go ahead until the user has typed a word.
 *
 * THE TYPED WORD IS A PAUSE, NOT A LOCK. It is here to make someone stop and
 * read what is about to be destroyed, and to be sure it is the thing they
 * meant — the same job the command line's typed confirmation does. It
 * protects against a slip of the hand. It is not a security control, and the
 * main process does not check it: what may be done is decided there.
 *
 * Matching ignores upper and lower case and spaces at either end. Making
 * someone retype a name because of a capital letter adds irritation, not care.
 *
 * While the action is running the dialog cannot be dismissed: closing it then
 * would only hide something still happening.
 *
 * What goes in the body, and what the buttons say, is the caller's.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { Button } from "./button.js";

export interface ConfirmDialogProps {
  title: string;
  /** What is about to happen, and whatever choices come with it. */
  children: ReactNode;
  /** The word that must be typed before either action is available. */
  confirmWord: string;
  confirmLabel: string;
  onConfirm(): void;
  /** A second way forward, offered beside the first — and behind the same typed word. */
  alternative?: { label: string; testId: string; onChoose(): void };
  onCancel(): void;
  /** The action is running. Everything is disabled and the dialog stays open. */
  working: boolean;
  /** Names the dialog's parts for tests: `<testId>`, `-word`, `-confirm`, `-cancel`. */
  testId: string;
}

export function ConfirmDialog({
  title,
  children,
  confirmWord,
  confirmLabel,
  onConfirm,
  alternative,
  onCancel,
  working,
  testId,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState("");
  const matches = typed.trim().toLowerCase() === confirmWord.trim().toLowerCase();
  const titleId = useId();
  const fieldId = useId();

  // Focus goes into the dialog when it opens and back where it was when it
  // closes, so the keyboard is never left behind on the screen underneath.
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    field.current?.focus();
    return () => before?.focus();
  }, []);

  const cancel = (): void => {
    if (!working) onCancel();
  };

  return (
    <div
      data-testid={`${testId}-backdrop`}
      className="fixed inset-0 z-10 flex items-center justify-center bg-slate-900/50 p-6"
      onMouseDown={(event) => {
        // Only a press on the backdrop itself: not one that started inside the
        // dialog and ended outside it.
        if (event.target === event.currentTarget) cancel();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        data-working={working ? "true" : "false"}
        className="max-h-full w-full max-w-md overflow-y-auto rounded-lg bg-white p-6 shadow-xl dark:bg-slate-900"
        onKeyDown={(event) => {
          if (event.key === "Escape") cancel();
        }}
      >
        <h2 id={titleId} className="mb-3 text-lg font-semibold">
          {title}
        </h2>

        <div className="text-sm">{children}</div>

        <form
          className="mt-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (matches && !working) onConfirm();
          }}
        >
          <label htmlFor={fieldId} className="mb-1 block text-sm">
            Type <span className="font-semibold">{confirmWord}</span> to confirm.
          </label>
          <input
            id={fieldId}
            ref={field}
            data-testid={`${testId}-word`}
            type="text"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            disabled={working}
            autoComplete="off"
            spellCheck={false}
            className="w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm disabled:opacity-60 dark:border-slate-700 dark:bg-slate-950"
          />

          <div className="mt-5 flex flex-wrap items-center justify-end gap-2">
            <Button variant="secondary" data-testid={`${testId}-cancel`} onClick={cancel} disabled={working}>
              Cancel
            </Button>
            {alternative !== undefined && (
              <Button
                variant="secondary"
                data-testid={alternative.testId}
                onClick={alternative.onChoose}
                disabled={!matches || working}
              >
                {alternative.label}
              </Button>
            )}
            <Button variant="danger" type="submit" data-testid={`${testId}-confirm`} disabled={!matches || working}>
              {working ? "Working…" : confirmLabel}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}
