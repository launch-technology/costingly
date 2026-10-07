/**
 * The Plaid keys form: two fields, checked with Plaid before anything is
 * saved, and the two ways that can fail.
 *
 * Drawn here once and used twice — by first-run setup and by Settings — so
 * the fields, the "Required." lines and the failure messages are the same
 * form wherever the keys are entered. What happens on submit is useKeysForm
 * (hooks/use-keys-form.ts); the caller passes its form object in and puts
 * its own words and buttons around this.
 *
 * The two failures are worded differently because they are fixed
 * differently — retype the keys, or check the connection.
 */

import type { ReactNode } from "react";

import type { KeysForm as KeysFormState } from "../hooks/use-keys-form.js";
import { Alert, AlertReason } from "./alert.js";
import { Button } from "./button.js";
import { TextField } from "./text-field.js";

export interface KeysFormProps {
  form: KeysFormState;
  /** Names the form for tests: `<testId>` on the form itself. */
  testId: string;
  submitLabel: string;
  /** Drawn before the fields: an explanation, a link to Plaid. */
  before?: ReactNode;
  /** Drawn beside the submit button: a Back link, say. */
  beside?: ReactNode;
}

export function KeysForm({ form, testId, submitLabel, before, beside }: KeysFormProps) {
  return (
    <form data-testid={testId} onSubmit={form.submit} noValidate>
      {before}

      <TextField
        id={`${testId}-client-id`}
        testId="keys-client-id"
        label="Plaid client ID"
        value={form.clientId}
        onChange={form.setClientId}
        missing={form.missing.clientId}
        disabled={form.checking}
      />
      <TextField
        id={`${testId}-secret`}
        testId="keys-secret"
        label="Plaid secret"
        type="password"
        value={form.secret}
        onChange={form.setSecret}
        missing={form.missing.secret}
        disabled={form.checking}
      />

      {form.failure !== null && (
        <Alert
          data-testid="keys-error"
          data-kind={form.failure.kind}
          title={
            form.failure.kind === "rejected"
              ? "Plaid rejected these keys. Nothing was saved."
              : "Plaid could not be reached. Nothing was saved."
          }
        >
          <p className="mt-1">
            {form.failure.kind === "rejected"
              ? "Check the client ID and enter the secret again."
              : "Check your internet connection and try again."}
          </p>
          <AlertReason>{form.failure.reason}</AlertReason>
        </Alert>
      )}

      <div className="flex items-center gap-4">
        <Button type="submit" data-testid="keys-submit" disabled={form.checking}>
          {form.checking ? "Checking with Plaid…" : submitLabel}
        </Button>
        {beside}
      </div>
    </form>
  );
}
