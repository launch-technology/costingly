/**
 * The keys step: two fields, checked with Plaid before anything is saved.
 *
 * Drawing only; what happens on submit is useKeysForm. The two failures are
 * worded differently here because they are fixed differently — retype the
 * keys, or check the connection.
 */

import { Alert, AlertReason } from "../../components/alert.js";
import { Button } from "../../components/button.js";
import { TextField } from "../../components/text-field.js";
import { openPlaidKeysPage, useKeysForm } from "../../hooks/use-setup.js";

export function KeysStep({ onAccepted, onBack }: { onAccepted(): void; onBack(): void }) {
  const form = useKeysForm(onAccepted);

  return (
    <form data-testid="keys-step" onSubmit={form.submit} noValidate>
      <p className="mb-5 text-sm text-slate-600 dark:text-slate-300">
        Costingly reads your banks through Plaid, using your own Plaid keys.{" "}
        <Button variant="link" data-testid="keys-help-link" onClick={openPlaidKeysPage}>
          Where do I find these?
        </Button>
      </p>

      <TextField
        id="plaid-client-id"
        testId="keys-client-id"
        label="Plaid client ID"
        value={form.clientId}
        onChange={form.setClientId}
        missing={form.missing.clientId}
        disabled={form.checking}
      />
      <TextField
        id="plaid-secret"
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
          {form.checking ? "Checking with Plaid…" : "Continue"}
        </Button>
        <Button variant="link" data-testid="keys-back" onClick={onBack} disabled={form.checking}>
          Back
        </Button>
      </div>
    </form>
  );
}
